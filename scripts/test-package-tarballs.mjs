import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commandTimeoutMs = positiveTimeout(process.env.AIT_PACKAGE_SMOKE_TIMEOUT_MS, 120_000);
const installCommandTimeoutMs = positiveTimeout(process.env.AIT_PACKAGE_INSTALL_TIMEOUT_MS, 300_000);
const RN_PLATFORM_PACKAGE = "@apps-in-toss/framework";
const WEB_PLATFORM_PACKAGE = "@apps-in-toss/web-framework";
// Exact official versions the @ait-kit/sdk adapters were developed and
// verified against. The peerDependency ranges in packages/sdk/package.json
// must stay aligned with these floors.
const OFFICIAL_SDK_VERSIONS = {
  rn: "2.10.10",
  web: "3.4.0"
};
const localPackages = readdirSync(join(rootDir, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages", entry.name))
  .flatMap((relativeDir) => {
    const manifestPath = join(rootDir, relativeDir, "package.json");
    return existsSync(manifestPath) ? [{ relativeDir, manifest: readJsonFile(manifestPath) }] : [];
  });
const localPackageNames = new Set(localPackages.map(({ manifest }) => manifest.name).filter(Boolean));
const publishablePackages = localPackages.filter(
  ({ manifest }) => manifest.private !== true && manifest.publishConfig?.access === "public"
);
if (publishablePackages.length === 0) {
  throw new Error("No public packages were found for tarball verification");
}
const tempDir = mkdtempSync(join(tmpdir(), "ait-kit-pack-"));
const packedPackages = [];
let verificationError;

try {
  for (const { relativeDir, manifest } of publishablePackages) {
    const packageDir = join(rootDir, relativeDir);
    const pack = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", tempDir], packageDir);
    let packResults;
    try {
      packResults = JSON.parse(pack.stdout);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error(`Failed to parse npm pack output for ${relativeDir}:\n${pack.stdout}`);
    }
    const [result] = Array.isArray(packResults) ? packResults : [];
    if (
      !Array.isArray(result?.files) ||
      typeof result.filename !== "string" ||
      typeof result.name !== "string"
    ) {
      throw new Error(`npm pack returned an unexpected result for ${relativeDir}:\n${pack.stdout}`);
    }
    const files = new Set(result.files.map((file) => file.path));
    for (const required of ["README.md", "LICENSE", "package.json"]) {
      if (!files.has(required)) {
        throw new Error(`${result.name} tarball is missing ${required}`);
      }
    }

    const exportPaths = ["."];
    if (manifest.name === "@ait-kit/api-client") {
      // The Node mTLS transport must ship its own runtime + types entry.
      exportPaths.push("./node");
    }
    if (manifest.name === "@ait-kit/sdk") {
      // Both platform adapters must ship their own runtime + types entries.
      exportPaths.push("./rn", "./web");
    }
    for (const exportPath of exportPaths) {
      const importExport = manifest.exports?.[exportPath]?.import;
      const typesExport = manifest.exports?.[exportPath]?.types;
      if (
        typeof importExport !== "string" ||
        typeof typesExport !== "string" ||
        !importExport.startsWith("./") ||
        !typesExport.startsWith("./")
      ) {
        throw new Error(
          `${result.name} must define string exports[${JSON.stringify(exportPath)}].import and .types targets`
        );
      }
      for (const exportTarget of [importExport, typesExport]) {
        if (!files.has(exportTarget.replace(/^\.\//, "")) || !existsSync(join(packageDir, exportTarget))) {
          throw new Error(`${result.name} export does not exist in its tarball: ${exportTarget}`);
        }
      }
    }
    packedPackages.push({
      name: result.name,
      version: result.version,
      tarballPath: join(tempDir, result.filename),
      packageDir,
      manifest,
      hasNodeExport: manifest.name === "@ait-kit/api-client",
      hasRnExport: manifest.name === "@ait-kit/sdk",
      requiresWorkerLoader: packageUsesCloudflareWorkers(packageDir, files)
    });
    console.log(`Packed ${result.name}@${result.version}`);
  }

  const workerResolverPath = join(tempDir, "cloudflare-worker-resolver.mjs");
  writeFileSync(
    workerResolverPath,
    `// Keep runtime mocks explicit so new Cloudflare imports require a deliberate test update.
const workerModuleUrl = "data:text/javascript," + encodeURIComponent("export class WorkerEntrypoint {}");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: workerModuleUrl,
      shortCircuit: true
    };
  }
  return nextResolve(specifier, context);
}
`
  );
  const workerRegisterPath = join(tempDir, "cloudflare-worker-register.mjs");
  writeFileSync(
    workerRegisterPath,
    `import { register } from "node:module";
register("./cloudflare-worker-resolver.mjs", import.meta.url);
`
  );

  for (const packedPackage of packedPackages) {
    const installDir = join(tempDir, "install", packedPackage.name.replace(/^@/, "").replaceAll("/", "-"));
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "package.json"), JSON.stringify({ private: true, type: "module" }));

    const localDependencyTarballs = transitiveLocalDependencyTarballs(
      packedPackage,
      packedPackages,
      localPackageNames
    );
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        packedPackage.tarballPath,
        ...localDependencyTarballs
      ],
      installDir,
      installCommandTimeoutMs
    );

    const importScriptPath = join(installDir, "smoke-import.mjs");
    writeFileSync(importScriptPath, `import ${JSON.stringify(packedPackage.name)};\n`);
    const importArgs = [importScriptPath];
    if (packedPackage.requiresWorkerLoader) {
      importArgs.unshift("--no-warnings", "--import", workerRegisterPath);
    }
    run(process.execPath, importArgs, installDir);

    if (packedPackage.hasNodeExport) {
      // Prove the installed /node entry runs a real request through Node's
      // https stack in the isolated consumer. Port 9 (discard) is closed, so
      // the transport must reject with its own typed error — never hang.
      const nodeSmokePath = join(installDir, "smoke-node.mjs");
      writeFileSync(
        nodeSmokePath,
        `import { createNodeMtlsTransport, NodeMtlsTransportError } from ${JSON.stringify(
          `${packedPackage.name}/node`
        )};
const transport = createNodeMtlsTransport({
  cert: "-----BEGIN CERTIFICATE-----\\nplaceholder\\n-----END CERTIFICATE-----\\n",
  key: "-----BEGIN PRIVATE KEY-----\\nplaceholder\\n-----END PRIVATE KEY-----\\n",
  timeoutMs: 5000
});
try {
  await transport.request("https://127.0.0.1:9/health", { method: "GET" });
  throw new Error("expected the node transport request to reject");
} catch (error) {
  if (!(error instanceof NodeMtlsTransportError)) {
    throw new Error(\`node transport rejected with an unexpected error: \${error}\`);
  }
  if (error.code !== "REQUEST_FAILED") {
    throw new Error(\`node transport returned code \${error.code}, expected REQUEST_FAILED\`);
  }
}
`
      );
      run(process.execPath, [nodeSmokePath], installDir);
    }

    if (packedPackage.hasRnExport) {
      verifySdkPlatformIsolation(packedPackage, installDir, tempDir, installCommandTimeoutMs);
      verifySdkOfficialCompatibility(packedPackage, installDir, tempDir, installCommandTimeoutMs);
    }
    console.log(`Verified ${packedPackage.name}@${packedPackage.version}`);
  }
} catch (error) {
  verificationError = error;
  throw error;
} finally {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (!verificationError) throw cleanupError;
    console.error(`WARNING: Failed to clean up ${tempDir}:`, cleanupError);
  }
}

function transitiveLocalDependencyTarballs(rootPackage, allPackages, allLocalPackageNames) {
  const packagesByName = new Map(allPackages.map((candidate) => [candidate.name, candidate]));
  const pending = installDependencyNames(rootPackage.manifest);
  const found = new Map();
  while (pending.length > 0) {
    const dependencyName = pending.shift();
    const candidate = packagesByName.get(dependencyName);
    if (!candidate) {
      if (allLocalPackageNames.has(dependencyName)) {
        throw new Error(`${rootPackage.name} depends on unpublished local package ${dependencyName}`);
      }
      continue;
    }
    if (candidate.name === rootPackage.name || found.has(candidate.name)) continue;
    found.set(candidate.name, candidate);
    pending.push(...installDependencyNames(candidate.manifest));
  }
  return [...found.values()].map((candidate) => candidate.tarballPath);
}

function installDependencyNames(manifest) {
  // The isolated smoke project is the consumer, so it must provide local peers explicitly.
  return Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {})
  });
}

function packageUsesCloudflareWorkers(packageDir, files) {
  const cloudflareImport = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']cloudflare:workers["']/;
  return [...files]
    .filter((filePath) => /\.(?:c|m)?js$/.test(filePath))
    .some((filePath) => cloudflareImport.test(readFileSync(join(packageDir, filePath), "utf8")));
}

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${filePath}: ${message}`);
  }
}

function run(command, args, cwd, timeoutMs = commandTimeoutMs) {
  const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: timeoutMs });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs / 1000} seconds`);
  }
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed to spawn: ${result.error.message}`);
  }
  if (result.status === null && result.signal) {
    throw new Error(`${command} ${args.join(" ")} was terminated by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (status=${result.status}, signal=${result.signal}):\n${
        result.stderr || result.stdout
      }`
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// @ait-kit/sdk platform verification
// ---------------------------------------------------------------------------

/**
 * Proves the shipped dist files never reference the opposite platform's
 * official SDK: /rn files only @apps-in-toss/framework, /web files only
 * @apps-in-toss/web-framework, and the runtime-neutral root files neither.
 */
function verifySdkCrossPlatformPurity(packageDir) {
  const distDir = join(packageDir, "dist");
  const offenders = [];
  const visit = (dir, zone) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const childZone = entry.name === "rn" || entry.name === "web" ? entry.name : zone;
        visit(entryPath, childZone);
        continue;
      }
      if (!/\.(?:js|mjs|cjs|d\.ts)$/.test(entry.name)) continue;
      const content = readFileSync(entryPath, "utf8");
      const relative = relativePath(distDir, entryPath);
      const hasRn = content.includes(RN_PLATFORM_PACKAGE);
      const hasWeb = content.includes(WEB_PLATFORM_PACKAGE);
      const violations =
        zone === "rn" ? [hasWeb && WEB_PLATFORM_PACKAGE] : zone === "web" ? [hasRn && RN_PLATFORM_PACKAGE] : [hasRn && RN_PLATFORM_PACKAGE, hasWeb && WEB_PLATFORM_PACKAGE];
      for (const violation of violations) {
        if (violation) offenders.push(`${relative} references ${violation}`);
      }
    }
  };
  visit(distDir, "root");
  if (offenders.length > 0) {
    throw new Error(`Cross-platform SDK leakage in ${packageDir}:\n${offenders.join("\n")}`);
  }
}

function relativePath(from, to) {
  const segments = [];
  let dir = to;
  while (dir !== from) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`${to} is not inside ${from}`);
    segments.unshift(basename(dir));
    dir = parent;
  }
  return segments.join("/");
}

/**
 * Stub-SDK fixtures: each platform installs the real tarball plus a stub of
 * ONLY its own platform SDK, proving the two entries stay independent (an
 * /rn consumer never needs the web SDK and vice versa, in JavaScript and in
 * the shipped declarations), then type-checks (bundler + NodeNext), bundles,
 * and executes the consumer against the installed package. The stub lacks
 * the five adapter-backed official exports, so the executed consumer also
 * proves the default loaders report UNSUPPORTED per operation instead of
 * guessing a call shape.
 */
function verifySdkPlatformIsolation(packedPackage, installDir, tempDir, installCommandTimeoutMs) {
  const platforms = [
    {
      subpath: "rn",
      platformPackage: RN_PLATFORM_PACKAGE,
      consumerImports: `import {
  createReactNativeAds,
  createReactNativeIdentity,
  createReactNativeIap,
  createReactNativeNotification,
  createReactNativeShare,
  createReactNativeStorage
} from ${JSON.stringify(`${packedPackage.name}/rn`)};`,
      consumerBody: `export const ads = createReactNativeAds();
export const iap = createReactNativeIap({ grant: async () => {} });
export const identity = createReactNativeIdentity();
export const storage = createReactNativeStorage();
export const notification = createReactNativeNotification();
export const share = createReactNativeShare();
export async function crossEntryInstanceofCheck(): Promise<boolean> {
  try {
    await iap.getPendingOrders();
    return false;
  } catch (error) {
    return error instanceof SdkError;
  }
}

// The stub SDK exposes none of the official identity/notification/share
// exports, so the default loaders must report UNSUPPORTED per operation —
// never a guessed call into a missing function.
export async function missingCapabilityCheck(): Promise<boolean> {
  const expectUnsupported = async (action: () => Promise<unknown>, label: string) => {
    try {
      await action();
      throw new Error(\`\${label}: expected UNSUPPORTED\`);
    } catch (error) {
      return error instanceof SdkError && error.code === "UNSUPPORTED";
    }
  };
  return (
    (await expectUnsupported(() => identity.login(), "login")) &&
    (await expectUnsupported(() => identity.getAnonymousKey(), "anonymous key")) &&
    (await expectUnsupported(() => share.createLink("intoss://stub"), "share link")) &&
    (await expectUnsupported(() => share.sendMessage("x"), "share sheet")) &&
    (await expectUnsupported(() => notification.requestAgreement("TEMPLATE_1"), "notification"))
  );
}

// Executed by the fixture runner: must hold against the installed tarball.
if (!(await crossEntryInstanceofCheck())) {
  throw new Error("cross-entry SdkError instanceof check failed");
}
if (!(await missingCapabilityCheck())) {
  throw new Error("missing-capability UNSUPPORTED check failed");
}
`
    },
    {
      subpath: "web",
      platformPackage: WEB_PLATFORM_PACKAGE,
      consumerImports: `import {
  createWebIap,
  createWebIdentity,
  createWebNotification,
  createWebShare,
  createWebStorage
} from ${JSON.stringify(`${packedPackage.name}/web`)};`,
      consumerBody: `export const iap = createWebIap({ grant: async () => {} });
export const identity = createWebIdentity();
export const storage = createWebStorage();
export const notification = createWebNotification();
export const share = createWebShare();
export async function crossEntryInstanceofCheck(): Promise<boolean> {
  try {
    await iap.getPendingOrders();
    return false;
  } catch (error) {
    return error instanceof SdkError;
  }
}

export async function missingCapabilityCheck(): Promise<boolean> {
  const expectUnsupported = async (action: () => Promise<unknown>, label: string) => {
    try {
      await action();
      throw new Error(\`\${label}: expected UNSUPPORTED\`);
    } catch (error) {
      return error instanceof SdkError && error.code === "UNSUPPORTED";
    }
  };
  return (
    (await expectUnsupported(() => identity.login(), "login")) &&
    (await expectUnsupported(() => share.createLink("intoss://stub"), "share link")) &&
    (await expectUnsupported(() => share.sendMessage("x"), "share sheet")) &&
    (await expectUnsupported(() => notification.requestAgreement("TEMPLATE_1"), "notification"))
  );
}

if (!(await crossEntryInstanceofCheck())) {
  throw new Error("cross-entry SdkError instanceof check failed");
}
if (!(await missingCapabilityCheck())) {
  throw new Error("missing-capability UNSUPPORTED check failed");
}
`
    }
  ];

  verifySdkCrossPlatformPurity(packedPackage.packageDir);

  for (const platform of platforms) {
    // Subpath imports cleanly in plain Node even without its platform
    // SDK: the official package is an optional peer, imported lazily.
    const smokePath = join(installDir, `smoke-${platform.subpath}.mjs`);
    writeFileSync(smokePath, `import ${JSON.stringify(`${packedPackage.name}/${platform.subpath}`)};\n`);
    run(process.execPath, [smokePath], installDir);

    const fixtureDir = join(installDir, `${platform.subpath}-fixture`);
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
    // Minimal stub of this fixture's platform SDK: present as a package
    // (proving peer isolation) but with an IAP surface the loader will
    // reject, so the executed consumer check is deterministic.
    const stubDir = join(tempDir, "stubs", platform.platformPackage.replace("/", "-"));
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(
      join(stubDir, "package.json"),
      JSON.stringify({ name: platform.platformPackage, version: "0.0.0-stub", type: "module" })
    );
    writeFileSync(
      join(stubDir, "index.js"),
      platform.subpath === "rn"
        ? `export const loadFullScreenAd = () => () => {};\nexport const showFullScreenAd = () => () => {};\nexport const IAP = {};\n`
        : `export const IAP = {};\n`
    );
    writeFileSync(
      join(fixtureDir, "consumer.ts"),
      `import { SdkError } from ${JSON.stringify(packedPackage.name)};
${platform.consumerImports}
${platform.consumerBody}
`
    );
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        // The stub platform SDK deliberately carries a fake version below
        // the sdk's verified peer floor; the official-version compatibility
        // is checked separately in the official fixtures below.
        "--legacy-peer-deps",
        packedPackage.tarballPath,
        "typescript@6.0.3",
        "esbuild@0.28.2",
        stubDir
      ],
      fixtureDir,
      installCommandTimeoutMs
    );
    runTsc(fixtureDir, "consumer.ts", "bundler");
    run(
      "npm",
      [
        "exec",
        "--",
        "esbuild",
        "consumer.ts",
        "--bundle",
        "--format=esm",
        "--platform=node",
        `--external:${platform.platformPackage}`,
        "--outfile=consumer.js"
      ],
      fixtureDir
    );
    // NodeNext consumers resolve the shipped declarations directly; the
    // emitted d.ts must carry extension-safe specifiers.
    runTsc(fixtureDir, "consumer.ts", "nodenext");
    // Execute the bundled consumer: the cross-entry instanceof check and
    // the missing-capability UNSUPPORTED checks must hold at runtime
    // against the installed tarball.
    run(process.execPath, [join(fixtureDir, "consumer.js")], fixtureDir);
  }
}

function runTsc(cwd, file, moduleResolution, lib) {
  const moduleKind = moduleResolution === "bundler" ? "esnext" : moduleResolution;
  const args = [
    "exec",
    "--",
    "tsc",
    "--noEmit",
    "--strict",
    // Official SDK type trees (react-native et al.) are not strict-clean
    // internally; React Native projects standardly enable skipLibCheck.
    // The consumer files themselves are still fully checked.
    "--skipLibCheck",
    "--target",
    "es2022",
    "--module",
    moduleKind,
    "--moduleResolution",
    moduleResolution
  ];
  if (lib) {
    // The official RN types collide with lib.dom's globals (URL etc.);
    // React Native environments carry their own globals, not the DOM.
    args.push("--lib", lib);
  }
  args.push(file);
  run("npm", args, cwd);
}

/**
 * Official-SDK fixtures: each platform installs the real tarball plus the
 * EXACT verified official SDK release, then (1) type-checks consumers
 * written against the official declarations — including canary imports
 * that exist in the official package but not in @ait-kit/sdk's ambient
 * declarations, so a masking ambient would fail the check — and (2)
 * executes the default loaders against the real SDK distribution.
 *
 * RN runtime note: the full @apps-in-toss/framework entry imports UI
 * components (react-native, Granite, TDS) that only evaluate inside the
 * app runtime, so the executed consumer bundles the framework through a
 * shim that re-exports @apps-in-toss/native-modules — the same package the
 * framework itself re-exports the five adapter-backed functions from, at
 * the same version — with the native bridge layer stubbed. This mirrors a
 * Metro/Granite consumption graph (bundler resolution, all real SDK code,
 * native layer replaced) inside CI.
 */
function verifySdkOfficialCompatibility(packedPackage, installDir, tempDir, installCommandTimeoutMs) {
  const rnTypes = `// Type checks against the REAL @apps-in-toss/framework@${OFFICIAL_SDK_VERSIONS.rn} declarations.
// Canaries first: these exports exist in the official package but NOT in
// @ait-kit/sdk's ambient declaration for it — if the ambient declaration
// masked the real types, this file would not compile.
import { env, useGeolocation } from "${RN_PLATFORM_PACKAGE}";

// The five adapter-backed exports with their verified official signatures.
import {
  appLogin,
  getAnonymousKey,
  getTossShareLink,
  requestNotificationAgreement,
  share
} from "${RN_PLATFORM_PACKAGE}";

export async function loginType(): Promise<{ authorizationCode: string; referrer: "DEFAULT" | "SANDBOX" }> {
  return appLogin();
}

export async function anonymousKeyType(): Promise<{ type: "HASH"; hash: string } | "ERROR" | undefined> {
  return getAnonymousKey();
}

export function notificationType(
  onEvent: (result: { type: "newAgreement" | "alreadyAgreed" | "agreementRejected" }) => void,
  onError: (error: unknown) => void
): () => void {
  return requestNotificationAgreement({
    options: { templateCode: "TEMPLATE_CODE" },
    onEvent,
    onError
  });
}

export function shareLinkType(path: string, ogImageUrl?: string): Promise<string> {
  // Positional arguments — the official signature.
  return getTossShareLink(path, ogImageUrl);
}

export function shareType(message: string): Promise<void> {
  return share({ message });
}

// The test platform stubs are typed BY the official declarations, keeping
// the fixtures honest about the shapes they fake.
type AppLogin = typeof appLogin;
type GetAnonymousKey = typeof getAnonymousKey;
type RequestNotificationAgreement = typeof requestNotificationAgreement;
type GetTossShareLink = typeof getTossShareLink;
type Share = typeof share;
export const stubAppLogin: AppLogin = () => Promise.resolve({ authorizationCode: "stub", referrer: "DEFAULT" });
export const stubGetAnonymousKey: GetAnonymousKey = () => Promise.resolve({ type: "HASH", hash: "stub" });
export const stubRequestNotificationAgreement: RequestNotificationAgreement = () => () => {};
export const stubGetTossShareLink: GetTossShareLink = (path) => Promise.resolve(\`https://toss.im/\${path}\`);
export const stubShare: Share = () => Promise.resolve();

export const canary = { env, useGeolocation };
`;

  const webTypes = `// Type checks against the REAL @apps-in-toss/web-framework@${OFFICIAL_SDK_VERSIONS.web} declarations.
// Canary: TossAuth.isIntegrated exists in the official package but NOT in
// @ait-kit/sdk's ambient declaration — if the ambient masked the real
// types, this file would not compile.
import { Notification, Share, TossAuth, User } from "${WEB_PLATFORM_PACKAGE}";

export async function loginType(): Promise<{ authorizationCode: string; referrer: "DEFAULT" | "SANDBOX" }> {
  return TossAuth.login();
}

export async function anonymousKeyType(): Promise<{ type: "HASH"; hash: string }> {
  return User.getAnonymousKey();
}

export function notificationType(
  onEvent: (result: { type: "newAgreement" | "alreadyAgreed" | "agreementRejected" }) => void,
  onError: (error: unknown) => void
): () => void {
  return Notification.requestAgreement({
    options: { templateCode: "TEMPLATE_CODE" },
    onEvent,
    onError
  });
}

export function shareLinkType(path: string, ogImageUrl?: string): Promise<string> {
  return Share.createLink({ path, ogImageUrl });
}

export function shareType(message: string): Promise<void> {
  return Share.sendMessage({ message });
}

export const canary = { isIntegrated: TossAuth.isIntegrated };
`;

  const rnRuntime = `import { SdkError } from "${packedPackage.name}";
import {
  createReactNativeIdentity,
  createReactNativeNotification,
  createReactNativeShare,
  createReactNativeStorage
} from "${packedPackage.name}/rn";

// The stubbed native bridge rejects every call with this marker, proving
// the REAL official function ran (as opposed to an adapter stub).
const BRIDGE_ERROR = "native bridge unavailable in the tarball fixture";

function failIfAdapterError(error: unknown, label: string): void {
  if (error instanceof SdkError) {
    throw new Error(\`\${label}: adapter produced \${error.code} (\${error.message}) instead of reaching the official SDK function\`);
  }
}

// 1. Identity: the real appLogin/getAnonymousKey run and their bridge
// rejections propagate — NOT a namespace-mismatch UNSUPPORTED.
const identity = createReactNativeIdentity();
try {
  await identity.login();
  throw new Error("login: expected the stubbed bridge to reject");
} catch (error) {
  failIfAdapterError(error, "login");
}
try {
  await identity.getAnonymousKey();
  throw new Error("getAnonymousKey: expected the stubbed bridge to reject or sentinel");
} catch (error) {
  failIfAdapterError(error, "getAnonymousKey");
}

// 2. Share link: positional arguments reach the real getTossShareLink.
const share = createReactNativeShare();
try {
  await share.createLink("intoss://fixture");
  throw new Error("createLink: expected the stubbed bridge to reject");
} catch (error) {
  failIfAdapterError(error, "createLink");
}

// 3. Share sheet: the real share() runs. In this stubbed environment it
// either resolves (completed: the SDK call finished — its documented
// meaning) or rejects through the bridge marker (failed). Either proves
// the real function was reached; the regression would be UNSUPPORTED.
const sheetResult = await share.sendMessage("fixture message");
const sheetOk =
  sheetResult.status === "completed" ||
  (sheetResult.status === "failed" && sheetResult.reason?.includes(BRIDGE_ERROR));
if (!sheetOk) {
  throw new Error(\`sendMessage: unexpected result \${JSON.stringify(sheetResult)}\`);
}

// 4. Notification: the real requestNotificationAgreement runs. Without a
// real app version the SDK's own version gate throws during registration
// (propagated by the event flow), and with registration succeeding the
// request settles by its deadline — both prove the real function was
// reached; the regression would be an adapter UNSUPPORTED.
const notification = createReactNativeNotification({ timeoutMs: 250 });
await notification.requestAgreement("TEMPLATE_1").then(
  (result) => {
    if (result.status !== "timeout") {
      throw new Error(\`requestAgreement: unexpected result \${JSON.stringify(result)}\`);
    }
  },
  (error) => {
    failIfAdapterError(error, "requestAgreement");
  }
);

// 5. Storage: the real namespaced Storage surface passes the adapter's
// all-or-nothing check and the bridge rejection propagates.
const storage = createReactNativeStorage();
try {
  await storage.get("fixture-key");
  throw new Error("storage.get: expected the stubbed bridge to reject");
} catch (error) {
  failIfAdapterError(error, "storage.get");
}
`;

  const webRuntime = `import { SdkError } from "${packedPackage.name}";
import {
  createWebIdentity,
  createWebNotification,
  createWebShare,
  createWebStorage
} from "${packedPackage.name}/web";

// Outside the Toss webview every official web SDK call throws the
// environment assertion — proving the real module loaded and the shared
// namespaced contract matched it.
const WEBVIEW_ERROR = "apps-in-toss 웹뷰 환경이 아니에요";

function failIfAdapterError(error: unknown, label: string): void {
  if (error instanceof SdkError) {
    throw new Error(\`\${label}: adapter produced \${error.code} (\${error.message}) instead of reaching the official SDK\`);
  }
}

const identity = createWebIdentity();
try {
  await identity.login();
  throw new Error("login: expected the webview assertion");
} catch (error) {
  failIfAdapterError(error, "login");
}
try {
  await identity.getAnonymousKey();
  throw new Error("getAnonymousKey: expected the webview assertion");
} catch (error) {
  failIfAdapterError(error, "getAnonymousKey");
}

const share = createWebShare();
try {
  await share.createLink("intoss://fixture");
  throw new Error("createLink: expected the webview assertion");
} catch (error) {
  failIfAdapterError(error, "createLink");
}
const sheetResult = await share.sendMessage("fixture message");
if (sheetResult.status !== "failed" || !sheetResult.reason?.includes(WEBVIEW_ERROR)) {
  throw new Error(\`sendMessage: unexpected result \${JSON.stringify(sheetResult)}\`);
}

// The official Notification.requestAgreement asserts the webview during
// registration; the event flow surfaces that as a rejection (never an
// adapter UNSUPPORTED).
const notification = createWebNotification({ timeoutMs: 250 });
try {
  await notification.requestAgreement("TEMPLATE_1");
  throw new Error("requestAgreement: expected the webview assertion");
} catch (error) {
  failIfAdapterError(error, "requestAgreement");
}

const storage = createWebStorage();
try {
  await storage.get("fixture-key");
  throw new Error("storage.get: expected the webview assertion");
} catch (error) {
  failIfAdapterError(error, "storage.get");
}
`;

  const fixtures = [
    {
      name: "rn-official",
      install: [`${RN_PLATFORM_PACKAGE}@${OFFICIAL_SDK_VERSIONS.rn}`],
      typesFile: rnTypes,
      runtimeFile: rnRuntime,
      tscLib: "es2022",
      bundleArgs: (fixtureDir) => [
        "runtime.ts",
        "--bundle",
        "--format=esm",
        "--platform=node",
        // Metro-style graph: the full framework entry imports UI modules
        // that only evaluate in the app runtime, so the runtime fixture
        // resolves the framework to its native-modules re-export (the
        // package those five exports are defined in) and stubs the native
        // bridge layer.
        `--alias:${RN_PLATFORM_PACKAGE}=./framework-shim.mjs`,
        "--alias:react-native=./native-stubs/react-native.js",
        "--alias:@granite-js/react-native=./native-stubs/granite-react-native.js",
        "--alias:brick-module=./native-stubs/brick-module.js",
        "--outfile=runtime.bundle.mjs"
      ],
      extraFiles: (fixtureDir) => {
        writeFileSync(
          join(fixtureDir, "framework-shim.mjs"),
          `// Re-exports the package that defines the five adapter-backed exports.\nexport * from "@apps-in-toss/native-modules";\n`
        );
        const stubsDir = join(fixtureDir, "native-stubs");
        mkdirSync(stubsDir, { recursive: true });
        writeFileSync(
          join(stubsDir, "brick-module.js"),
          `// Native bridge stub: every bridge call rejects with the fixture marker
// (proving real SDK code reached the native boundary). The rejection is
// pre-handled so the SDK's own fire-and-forget calls (event listener
// registration during module init) cannot crash the process on an
// unhandled rejection; awaiting the returned promise still rejects.
const bridgeUnavailable = () => {
  const rejection = Promise.reject(new Error("native bridge unavailable in the tarball fixture"));
  rejection.catch(() => {});
  return rejection;
};
const nativeModule = new Proxy({}, {
  get(_target, prop) {
    if (prop === "addListener" || prop === "removeListeners") return () => {};
    return (..._args) => bridgeUnavailable();
  }
});
export const BrickModule = { get: () => nativeModule, getRegisteredModules: () => [] };
export default BrickModule;
`
        );
        writeFileSync(
          join(stubsDir, "react-native.js"),
          `export const AppRegistry = { registerComponent: () => {} };\nexport const NativeModules = {};\nexport const Platform = { OS: "android", select: (o) => o?.android };\nexport const Linking = { openURL: async () => {}, addEventListener: () => ({ remove: () => {} }) };\nexport default {};\n`
        );
        writeFileSync(
          join(stubsDir, "granite-react-native.js"),
          `export class GraniteEventDefinition extends EventTarget {}\nexport class GraniteEvent extends EventTarget {}\nexport const Granite = {};\nexport const getSchemeUri = () => "intoss://stub";\nexport const openURL = async () => {};\nexport default {};\n`
        );
      }
    },
    {
      name: "web-official",
      install: [`${WEB_PLATFORM_PACKAGE}@${OFFICIAL_SDK_VERSIONS.web}`],
      typesFile: webTypes,
      runtimeFile: webRuntime,
      tscLib: "es2022,dom",
      // The real web SDK is pure browser-side JS: bundle it INTO the
      // runtime fixture (not external) to exercise the real web bundle path.
      bundleArgs: () => [
        "runtime.ts",
        "--bundle",
        "--format=esm",
        "--platform=node",
        "--outfile=runtime.bundle.mjs"
      ],
      extraFiles: () => {}
    }
  ];

  for (const fixture of fixtures) {
    const fixtureDir = join(installDir, fixture.name);
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
    writeFileSync(join(fixtureDir, "official-types.ts"), fixture.typesFile);
    writeFileSync(join(fixtureDir, "runtime.ts"), fixture.runtimeFile);
    fixture.extraFiles(fixtureDir);
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        packedPackage.tarballPath,
        "typescript@6.0.3",
        "esbuild@0.28.2",
        ...fixture.install
      ],
      fixtureDir,
      installCommandTimeoutMs
    );
    runTsc(fixtureDir, "official-types.ts", "bundler", fixture.tscLib);
    runTsc(fixtureDir, "official-types.ts", "nodenext", fixture.tscLib);
    runTsc(fixtureDir, "runtime.ts", "bundler", fixture.tscLib);
    run("npm", ["exec", "--", "esbuild", ...fixture.bundleArgs(fixtureDir)], fixtureDir);
    run(process.execPath, [join(fixtureDir, "runtime.bundle.mjs")], fixtureDir);
  }
}
