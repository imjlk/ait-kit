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
import { repoFileUrl, startMtlsServer } from "./lib/start-mtls-server.mjs";

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
// Consumer type-check toolchain, pinned explicitly (never "latest"): every
// fixture runs on the long-standing consumer floor, and the server-declaration
// fixtures additionally re-run on the repository's own pinned TypeScript so
// regressions only newer tsc flags are caught in CI. Two pinned versions do
// not certify the versions between them.
const CONSUMER_TYPESCRIPT_VERSION = "6.0.3";
const REPO_TYPESCRIPT_VERSION = "7.0.2";
const NODE_TYPES_VERSION = "26.5.1";
const WORKERS_TYPES_VERSION = "5.20260915.1";
// The DOM-free Node consumer environment for server declarations: lib es2022
// plus @types/node provides fetch globals (Response/RequestInit/AbortSignal)
// without mixing Worker or DOM types into a Node check.
const NODE_TYPES_TSC_OPTIONS = { lib: "es2022", types: "node" };
// The Worker consumer environment stays separate: workers-types supplies the
// runtime globals, and lib es2022 keeps DOM declarations out.
const WORKER_TYPES_TSC_OPTIONS = { lib: "es2022", types: "@cloudflare/workers-types" };
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
      exportPaths.push("./rn", "./webview", "./web");
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

    if (packedPackage.name === "@ait-kit/api-core") {
      const contractPath = join(installDir, "recipient-contract.mjs");
      writeFileSync(contractPath,
        'import { createTossMtlsCore } from "@ait-kit/api-core";\n' +
        'import { checkRecipientContract } from ' + JSON.stringify(repoFileUrl("packages/api-core/test/helpers/recipient-contract.mjs")) + ';\n' +
        'await checkRecipientContract(createTossMtlsCore);\n');
      run(process.execPath, [contractPath], installDir);
    }

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

      // Full mTLS contract from the INSTALLED tarball against a real local
      // mTLS server, through the SAME shared scenarios the repo-build and
      // npm-release checks use (packages/api-client/test/helpers/
      // mtls-contract-check.mjs). The generated consumer is intentionally
      // thin: import the public /node export, read the certificate PATHS it
      // was handed (private material never travels through argv), delegate
      // to the shared scenarios, and report via JSON + exit code.
      // Connection-refused smokes alone do not verify the mTLS lifecycle or
      // response conversion.
      const mtls = await startMtlsServer({ clientCn: "ait-kit-tarball-client" });
      try {
        const nodeMtlsSmokePath = join(installDir, "smoke-node-mtls.mjs");
        writeFileSync(
          nodeMtlsSmokePath,
          'import { readFileSync } from "node:fs";\n' +
            'import { createNodeMtlsTransport, NodeMtlsTransportError } from ' +
            JSON.stringify(`${packedPackage.name}/node`) +
            ";\n" +
            "import { runMtlsContractChecks } from " +
            JSON.stringify(repoFileUrl("packages/api-client/test/helpers/mtls-contract-check.mjs")) +
            ";\n\n" +
            "const [baseUrl, caPath, certPath, keyPath] = process.argv.slice(2);\n" +
            "const result = await runMtlsContractChecks({\n" +
            "  createNodeMtlsTransport,\n" +
            "  NodeMtlsTransportError,\n" +
            "  baseUrl,\n" +
            '  ca: readFileSync(caPath, "utf8"),\n' +
            '  cert: readFileSync(certPath, "utf8"),\n' +
            '  key: readFileSync(keyPath, "utf8"),\n' +
            '  expectedClientCn: "ait-kit-tarball-client"\n' +
            "});\n" +
            "console.log(JSON.stringify(result));\n" +
            "process.exit(result.pass ? 0 : 1);\n"
        );
        run(
          process.execPath,
          [nodeMtlsSmokePath, mtls.baseUrl, mtls.caPath, mtls.certPath, mtls.keyPath],
          installDir
        );

        // The installed server declarations must carry extension-safe
        // relative specifiers (TS2834 otherwise breaks every NodeNext
        // consumer and cascades into TS2305). Asserting this on the
        // INSTALLED d.ts also proves the checks below resolve the tarball's
        // declarations, not workspace sources.
        assertInstalledDeclarationSpecifiers(installDir, "@ait-kit/api-core", "dist/index.d.ts");
        assertInstalledDeclarationSpecifiers(installDir, "@ait-kit/api-client", "dist/node/index.d.ts");
        const nodeTypesPath = join(installDir, "smoke-node-types.ts");
        writeFileSync(
          nodeTypesPath,
          'import { createNodeMtlsTransport, NodeMtlsTransportError, type NodeMtlsTransportOptions } from ' +
            JSON.stringify(`${packedPackage.name}/node`) +
            ";\n\n" +
            "const options: NodeMtlsTransportOptions = {\n" +
            '  cert: "cert",\n' +
            '  key: "key",\n' +
            "  timeoutMs: 1000,\n" +
            "  maxResponseBytes: 1024\n" +
            "};\n" +
            "const transport = createNodeMtlsTransport(options);\n" +
            // Constructing the error type-checks the constructor signature;
            // the runtime instanceof-Error behavior of thrown instances is
            // verified by the shared mTLS contract scenarios.
            'const transportError: NodeMtlsTransportError = new NodeMtlsTransportError("TIMEOUT", "fixture");\n' +
            "void transport; void transportError;\n\n" +
            "// @ts-expect-error required certificate options are missing\n" +
            "createNodeMtlsTransport({});\n" +
            "// @ts-expect-error timeoutMs must be a number\n" +
            'createNodeMtlsTransport({ cert: "cert", key: "key", timeoutMs: "1000" });\n'
        );
        // The root client and the /node transport used together: the root's
        // public declarations must reference api-core types under BOTH
        // bundler and NodeNext resolution, the IAP response union must
        // narrow correctly, and contract violations must be rejected.
        const rootTypesPath = join(installDir, "smoke-root-types.ts");
        writeFileSync(
          rootTypesPath,
          'import { createTossMtlsHttpClient, TossMtlsHttpClientError, type IapOrderStatusResponse } from ' +
            JSON.stringify(packedPackage.name) +
            ";\n" +
            'import { createNodeMtlsTransport } from ' +
            JSON.stringify(`${packedPackage.name}/node`) +
            ";\n\n" +
            'const transport = createNodeMtlsTransport({ cert: "cert", key: "key" });\n' +
            "const client = createTossMtlsHttpClient({\n" +
            '  baseUrl: "https://example.test",\n' +
            "  fetch: (input, init) => transport.request(String(input), init ?? {}),\n" +
            "  timeoutMs: 0\n" +
            "});\n" +
            "const clientError: TossMtlsHttpClientError = new TossMtlsHttpClientError(502, { ok: false });\n" +
            "void client; void clientError;\n\n" +
            "async function consumeIapStatus(orderId: string): Promise<string> {\n" +
            "  const response: IapOrderStatusResponse = await client.iapOrderStatus({ orderId });\n" +
            "  if (response.ok === false) {\n" +
            '    return response.error ?? "provider failure";\n' +
            "  }\n" +
            '  return response.verified ? "verified" : response.verificationCode;\n' +
            "}\n" +
            "void consumeIapStatus;\n\n" +
            "// @ts-expect-error baseUrl is a required option\n" +
            "createTossMtlsHttpClient({});\n"
        );
        // The documented injection combination on its own: a /node transport
        // assigned to api-core's MtlsClient and passed as mtlsClient. Runs
        // under both resolutions; @ts-expect-error proves the shipped types
        // reject contract violations (an any-weakened declaration surface
        // would surface these as unused-directive errors instead).
        const coreTransportPath = join(installDir, "smoke-core-transport.ts");
        writeFileSync(
          coreTransportPath,
          'import {\n' +
            "  createTossMtlsCore,\n" +
            "  type AppsInTossCoreOptions,\n" +
            "  type IapOrderStatusInput,\n" +
            "  type IapOrderStatusResponse,\n" +
            "  type MtlsClient,\n" +
            "  type SmartMessageSendInput,\n" +
            "  type TossMtlsCore\n" +
            '} from "@ait-kit/api-core";\n' +
            'import { createNodeMtlsTransport } from ' +
            JSON.stringify(`${packedPackage.name}/node`) +
            ";\n\n" +
            'const transport = createNodeMtlsTransport({ cert: "fixture-cert", key: "fixture-key" }) satisfies MtlsClient;\n\n' +
            'const options: AppsInTossCoreOptions = { mode: "forward", mtlsClient: transport };\n' +
            "const core: TossMtlsCore = createTossMtlsCore(options);\n\n" +
            "async function consumeIapStatus(input: IapOrderStatusInput): Promise<string> {\n" +
            "  const response: IapOrderStatusResponse = await core.iapOrderStatus(input);\n" +
            "  if (response.ok === false) {\n" +
            '    return response.error ?? "provider failure";\n' +
            "  }\n" +
            "  if (response.verified) {\n" +
            '    return "verified";\n' +
            "  }\n" +
            "  return response.verificationCode;\n" +
            "}\n" +
            "void consumeIapStatus;\n\n" +
            "async function consumeMessage(body: SmartMessageSendInput): Promise<string> {\n" +
            "  const response = await core.smartMessageSend(body);\n" +
            '  return response.ok ? (response.resultType ?? "sent") : (response.error ?? "failed");\n' +
            "}\n" +
            "void consumeMessage;\n\n" +
            "// @ts-expect-error a MtlsClient must resolve to a Response, not a number\n" +
            "const invalidClient: MtlsClient = { request: async () => 42 };\n" +
            "// @ts-expect-error tossPromotionAmount must be a number\n" +
            'createTossMtlsCore({ tossPromotionAmount: "500", mtlsClient: transport });\n' +
            "// @ts-expect-error orderId must be a string\n" +
            "core.iapOrderStatus({ orderId: 123 });\n" +
            "async function unguarded(response: IapOrderStatusResponse): Promise<string> {\n" +
            "  // @ts-expect-error verificationCode requires narrowing to the unverified variant\n" +
            "  return response.verificationCode;\n" +
            "}\n" +
            "void unguarded;\n" +
            "void invalidClient;\n"
        );
        run(
          "npm",
          [
            "install",
            "--ignore-scripts",
            "--no-package-lock",
            "--no-audit",
            "--no-fund",
            `typescript@${CONSUMER_TYPESCRIPT_VERSION}`,
            `@types/node@${NODE_TYPES_VERSION}`
          ],
          installDir,
          installCommandTimeoutMs
        );
        logTypescriptVersion(installDir, "server declarations, consumer floor");
        runTsc(installDir, "smoke-node-types.ts", "bundler", NODE_TYPES_TSC_OPTIONS);
        runTsc(installDir, "smoke-node-types.ts", "nodenext", NODE_TYPES_TSC_OPTIONS);
        runTsc(installDir, "smoke-root-types.ts", "bundler", NODE_TYPES_TSC_OPTIONS);
        runTsc(installDir, "smoke-root-types.ts", "nodenext", NODE_TYPES_TSC_OPTIONS);
        runTsc(installDir, "smoke-core-transport.ts", "bundler", NODE_TYPES_TSC_OPTIONS);
        runTsc(installDir, "smoke-core-transport.ts", "nodenext", NODE_TYPES_TSC_OPTIONS);
        // Re-run the same consumer files on the repository's own pinned
        // TypeScript: a declaration regression only newer tsc flags must
        // still fail CI.
        run(
          "npm",
          [
            "install",
            "--ignore-scripts",
            "--no-package-lock",
            "--no-audit",
            "--no-fund",
            `typescript@${REPO_TYPESCRIPT_VERSION}`
          ],
          installDir,
          installCommandTimeoutMs
        );
        logTypescriptVersion(installDir, "server declarations, repo toolchain");
        runTsc(installDir, "smoke-node-types.ts", "bundler", NODE_TYPES_TSC_OPTIONS);
        runTsc(installDir, "smoke-node-types.ts", "nodenext", NODE_TYPES_TSC_OPTIONS);
        runTsc(installDir, "smoke-root-types.ts", "bundler", NODE_TYPES_TSC_OPTIONS);
        runTsc(installDir, "smoke-root-types.ts", "nodenext", NODE_TYPES_TSC_OPTIONS);
        runTsc(installDir, "smoke-core-transport.ts", "bundler", NODE_TYPES_TSC_OPTIONS);
        runTsc(installDir, "smoke-core-transport.ts", "nodenext", NODE_TYPES_TSC_OPTIONS);
      } finally {
        await mtls.close();
      }
    }

    if (packedPackage.hasRnExport) {
      verifySdkPlatformIsolation(packedPackage, installDir, tempDir, installCommandTimeoutMs);
      verifySdkOfficialCompatibility(packedPackage, installDir, tempDir, installCommandTimeoutMs);
    }
    if (packedPackage.manifest.name === "@ait-kit/api-orpc") {
      verifyOrpcDeclarations(packedPackage, installDir, installCommandTimeoutMs);
    }
    if (packedPackage.manifest.name === "@ait-kit/api-cloudflare-service") {
      verifyCloudflareServiceDeclarations(packedPackage, installDir, installCommandTimeoutMs);
    }
    console.log(`Verified ${packedPackage.name}@${packedPackage.version}`);
  }

  // Regression tests for the verification tooling itself (failure paths,
  // wrong-target protection, cleanup). Local fixtures only — this never
  // replaces the real npm-release verification command.
  console.log("Running verification-tooling selftest...");
  run(process.execPath, [join(rootDir, "scripts/verify-published-node.selftest.mjs")], rootDir, 300_000);
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
 * official SDK: /rn files only @apps-in-toss/framework, /webview files only
 * @apps-in-toss/web-framework, and the runtime-neutral root files neither.
 */
function verifySdkCrossPlatformPurity(packageDir) {
  const distDir = join(packageDir, "dist");
  const offenders = [];
  const visit = (dir, zone) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const childZone = entry.name === "rn" || entry.name === "webview" ? entry.name : zone;
        visit(entryPath, childZone);
        continue;
      }
      if (!/\.(?:js|mjs|cjs|d\.ts)$/.test(entry.name)) continue;
      const content = readFileSync(entryPath, "utf8");
      const relative = relativePath(distDir, entryPath);
      const hasRn = content.includes(RN_PLATFORM_PACKAGE);
      const hasWeb = content.includes(WEB_PLATFORM_PACKAGE);
      const violations =
        zone === "rn" ? [hasWeb && WEB_PLATFORM_PACKAGE] : zone === "webview" ? [hasRn && RN_PLATFORM_PACKAGE] : [hasRn && RN_PLATFORM_PACKAGE, hasWeb && WEB_PLATFORM_PACKAGE];
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
  createReactNativePromotion,
  createReactNativeReview,
  createReactNativeShare,
  createReactNativeStorage
} from ${JSON.stringify(`${packedPackage.name}/rn`)};`,
      consumerBody: `export const ads = createReactNativeAds();
export const iap = createReactNativeIap({ grant: async () => {} });
export const identity = createReactNativeIdentity();
export const storage = createReactNativeStorage();
export const notification = createReactNativeNotification();
export const promotion = createReactNativePromotion();
export const review = createReactNativeReview();
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
    (await expectUnsupported(() => iap.getCompletedOrRefundedOrders(), "order history")) &&
    (await expectUnsupported(() => iap.getSubscriptionInfo("order"), "subscription info")) &&
    (await promotion.getSupport()) === "unsupported" &&
    (await expectUnsupported(() => promotion.grantReward({ promotionCode: "SYNTHETIC", amount: 1 }), "promotion")) &&
    !(await review.isSupported()) &&
    (await expectUnsupported(() => review.request(), "review")) &&
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
      subpath: "webview",
      platformPackage: WEB_PLATFORM_PACKAGE,
      consumerImports: `import {
  createWebViewAds,
  createWebViewIap,
  createWebViewIdentity,
  createWebViewNotification,
  createWebViewPromotion,
  createWebViewReview,
  createWebViewShare,
  createWebViewStorage
} from ${JSON.stringify(`${packedPackage.name}/webview`)};`,
      consumerBody: `export const ads = createWebViewAds();
export const iap = createWebViewIap({ grant: async () => {} });
export const identity = createWebViewIdentity();
export const storage = createWebViewStorage();
export const notification = createWebViewNotification();
export const promotion = createWebViewPromotion();
export const review = createWebViewReview();
export const share = createWebViewShare();
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
    (await expectUnsupported(() => iap.getCompletedOrRefundedOrders(), "order history")) &&
    (await expectUnsupported(() => iap.getSubscriptionInfo("order"), "subscription info")) &&
    (await promotion.getSupport()) === "unsupported" &&
    (await expectUnsupported(() => promotion.grantReward({ promotionCode: "SYNTHETIC", amount: 1 }), "promotion")) &&
    !(await review.isSupported()) &&
    (await expectUnsupported(() => review.request(), "review")) &&
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
${platform.subpath === "webview" ? `import * as legacy from "${packedPackage.name}/web";
import * as canonical from "${packedPackage.name}/webview";
const legacyOptions: legacy.WebIapOptions = { grant: async () => {} };
const canonicalOptions: canonical.WebViewIapOptions = legacyOptions;
for (const capability of ["Iap", "Identity", "Storage", "Notification", "Share", "Review", "Promotion"] as const) {
  if (legacy[\`createWeb\${capability}\`] !== canonical[\`createWebView\${capability}\`]) {
    throw new Error(\`Legacy Web alias differs for \${capability}\`);
  }
}
export const legacyIap: legacy.WebIap = legacy.createWebIap(canonicalOptions);
` : ""}
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
    // A real dynamic import fails once, then resolves the installed stub.
    // Exercise the DEFAULT loader cache rather than a replacement loader.
    writeFileSync(join(fixtureDir, "retry-loader.mjs"), `
let failed = false;
export async function resolve(specifier, context, nextResolve) {
  if (specifier === ${JSON.stringify(platform.platformPackage)} && !failed) {
    failed = true;
    throw new Error("fixture transient import failure");
  }
  return nextResolve(specifier, context);
}
`);
    const reviewFactory = platform.subpath === "rn" ? "createReactNativeReview" : "createWebViewReview";
    writeFileSync(join(fixtureDir, "retry.mjs"), `
import { ${reviewFactory} } from ${JSON.stringify(`${packedPackage.name}/${platform.subpath}`)};
const review = ${reviewFactory}();
let unavailable = false;
try { await review.isSupported(); } catch (error) { unavailable = error.code === "SDK_UNAVAILABLE"; }
if (!unavailable) throw new Error("first import must fail observably");
if (await review.isSupported() !== false) throw new Error("retry must load the stub's missing capability");
`);
    run(process.execPath, ["--loader", "./retry-loader.mjs", "retry.mjs"], fixtureDir);
    const promotionFactory = platform.subpath === "rn" ? "createReactNativePromotion" : "createWebViewPromotion";
    writeFileSync(join(fixtureDir, "retry-promotion.mjs"), `
import { ${promotionFactory} } from ${JSON.stringify(`${packedPackage.name}/${platform.subpath}`)};
const promotion = ${promotionFactory}();
let unavailable = false;
try { await promotion.getSupport(); } catch (error) { unavailable = error.code === "SDK_UNAVAILABLE"; }
if (!unavailable) throw new Error("first promotion import must fail observably");
if (await promotion.getSupport() !== "unsupported") throw new Error("retry must load the stub");
`);
    run(process.execPath, ["--loader", "./retry-loader.mjs", "retry-promotion.mjs"], fixtureDir);


  }
}


function runTsc(cwd, file, moduleResolution, options = {}) {
  const moduleKind = moduleResolution === "bundler" ? "esnext" : moduleResolution;
  const args = [
    "exec",
    "--",
    "tsc",
    "--noEmit",
    "--strict",
    "--target",
    "es2022",
    "--module",
    moduleKind,
    "--moduleResolution",
    moduleResolution
  ];
  if (options.lib) {
    args.push("--lib", options.lib);
    if (options.skipLibCheck) {
      // Official SDK type trees (react-native et al.) are not strict-clean
      // internally; React Native projects standardly enable skipLibCheck.
      // Only the legacy SDK fixtures use this — server-declaration fixtures
      // keep checking the shipped declarations in full.
      args.push("--skipLibCheck");
    }
  }
  if (options.types) {
    args.push("--types", options.types);
  }
  args.push(file);
  run("npm", args, cwd);
}

/** Logs the exact tsc version a fixture directory will use for its checks. */
function logTypescriptVersion(cwd, label) {
  const result = run("npm", ["exec", "--", "tsc", "--version"], cwd);
  console.log(`TypeScript for ${label}: ${(result.stdout || "").trim()}`);
}

/**
 * The consumer fixtures must resolve the INSTALLED tarball's declarations,
 * so assert the installed d.ts really carries extension-safe relative
 * specifiers — the exact property this verification protects. A pre-fix
 * tarball installed by mistake fails here immediately instead of producing
 * confusing downstream TS2834/TS2305 cascades.
 */
function assertInstalledDeclarationSpecifiers(installDir, packageName, declarationPath) {
  const installed = readFileSync(join(installDir, "node_modules", packageName, declarationPath), "utf8");
  if (!/from "\.\/[a-z][a-z0-9-]*\.js"/.test(installed)) {
    throw new Error(
      `Installed ${packageName}/${declarationPath} does not use extension-safe relative specifiers (NodeNext consumers would fail with TS2834)`
    );
  }
}

/**
 * Checks the installed @ait-kit/api-orpc declarations for an independent
 * consumer under bundler AND NodeNext resolution. @orpc/server lists
 * @opentelemetry/api as an optional peer and references it from its shipped
 * declarations, so without it installed the check reports a TS2307 that is
 * an EXTERNAL dependency gap, not an api-orpc defect — installing it keeps
 * this fixture focused on api-orpc's own declaration connectivity.
 */
function verifyOrpcDeclarations(packedPackage, installDir, installCommandTimeoutMs) {
  const fixtureDir = join(installDir, "orpc-types");
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(
    join(fixtureDir, "consumer.ts"),
    'import {\n' +
      "  healthInputSchema,\n" +
      "  healthOutputSchema,\n" +
      "  publicRouter,\n" +
      "  smartMessageOutputSchema,\n" +
      "  smartMessageSendInputSchema,\n" +
      "  type PublicApiContext,\n" +
      "  type PublicRouter,\n" +
      "  type PublicRouterInputs,\n" +
      "  type PublicRouterOutputs\n" +
      '} from "@ait-kit/api-orpc";\n\n' +
      "const router: PublicRouter = publicRouter;\n" +
      "void router;\n" +
      'type HealthInput = PublicRouterInputs["health"];\n' +
      'type SmartMessageSendOutput = PublicRouterOutputs["smartMessage"]["send"];\n' +
      "const healthQuery: HealthInput = healthInputSchema.parse(undefined);\n" +
      'const messageOutput: SmartMessageSendOutput = smartMessageOutputSchema.parse({ ok: true, providerStatus: "sent" });\n' +
      "const healthStatus = healthOutputSchema.parse({ ok: true });\n" +
      "void healthQuery; void messageOutput; void healthStatus;\n" +
      'const message = smartMessageSendInputSchema.parse({ tossUserKey: "user", templateCode: "TEMPLATE_1", context: {} });\n' +
      "void message;\n\n" +
      "// @ts-expect-error tossApi is a required context member\n" +
      "const brokenContext: PublicApiContext = { tossApi: null };\n" +
      "void brokenContext;\n"
  );
  const installArgs = [
    "install",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    "--prefer-offline",
    packedPackage.tarballPath,
    ...transitiveLocalDependencyTarballs(packedPackage, packedPackages, localPackageNames),
    `typescript@${CONSUMER_TYPESCRIPT_VERSION}`,
    `@types/node@${NODE_TYPES_VERSION}`,
    "@opentelemetry/api@1.9.1"
  ];
  run("npm", installArgs, fixtureDir, installCommandTimeoutMs);
  assertInstalledDeclarationSpecifiers(fixtureDir, "@ait-kit/api-orpc", "dist/index.d.ts");
  logTypescriptVersion(fixtureDir, "api-orpc declarations, consumer floor");
  runTsc(fixtureDir, "consumer.ts", "bundler", NODE_TYPES_TSC_OPTIONS);
  runTsc(fixtureDir, "consumer.ts", "nodenext", NODE_TYPES_TSC_OPTIONS);
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      `typescript@${REPO_TYPESCRIPT_VERSION}`
    ],
    fixtureDir,
    installCommandTimeoutMs
  );
  logTypescriptVersion(fixtureDir, "api-orpc declarations, repo toolchain");
  runTsc(fixtureDir, "consumer.ts", "bundler", NODE_TYPES_TSC_OPTIONS);
  runTsc(fixtureDir, "consumer.ts", "nodenext", NODE_TYPES_TSC_OPTIONS);
}

/**
 * Checks the installed @ait-kit/api-cloudflare-service declarations in a
 * Worker-typed consumer environment (official @cloudflare/workers-types,
 * DOM-free lib) under bundler AND NodeNext resolution. This verifies
 * declaration connectivity only — it does not attempt to run Worker code in
 * a plain Node process.
 */
function verifyCloudflareServiceDeclarations(packedPackage, installDir, installCommandTimeoutMs) {
  const fixtureDir = join(installDir, "cloudflare-types");
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(
    join(fixtureDir, "consumer.ts"),
    'import {\n' +
      "  AppsInTossApiService,\n" +
      "  createCloudflareMtlsClient,\n" +
      "  createServiceRpc,\n" +
      "  type AppsInTossServiceEnv\n" +
      '} from "@ait-kit/api-cloudflare-service";\n' +
      'import type { MtlsClient } from "@ait-kit/api-core";\n\n' +
      "const env: AppsInTossServiceEnv = {\n" +
      '  TOSS_API_MODE: "stub",\n' +
      '  TOSS_API_BASE_URL: "https://example.test"\n' +
      "};\n" +
      "const rpc = createServiceRpc(env);\n" +
      "void rpc;\n\n" +
      "const transport: MtlsClient = createCloudflareMtlsClient({ fetch: (input, init) => fetch(input, init) });\n" +
      "void transport;\n\n" +
      "class MyTossService extends AppsInTossApiService {}\n" +
      "void MyTossService;\n\n" +
      "// @ts-expect-error TOSS_API_BASE_URL must be a string\n" +
      "createServiceRpc({ TOSS_API_BASE_URL: 123 });\n" +
      "// @ts-expect-error a MtlsClient must resolve to a Response, not a number\n" +
      "const badTransport: MtlsClient = { request: async () => 42 };\n" +
      "void badTransport;\n"
  );
  const installArgs = [
    "install",
    "--ignore-scripts",
    "--no-package-lock",
    "--no-audit",
    "--no-fund",
    "--prefer-offline",
    packedPackage.tarballPath,
    ...transitiveLocalDependencyTarballs(packedPackage, packedPackages, localPackageNames),
    `typescript@${CONSUMER_TYPESCRIPT_VERSION}`,
    `@cloudflare/workers-types@${WORKERS_TYPES_VERSION}`
  ];
  run("npm", installArgs, fixtureDir, installCommandTimeoutMs);
  assertInstalledDeclarationSpecifiers(fixtureDir, "@ait-kit/api-cloudflare-service", "dist/index.d.ts");
  logTypescriptVersion(fixtureDir, "api-cloudflare-service declarations, consumer floor");
  runTsc(fixtureDir, "consumer.ts", "bundler", WORKER_TYPES_TSC_OPTIONS);
  runTsc(fixtureDir, "consumer.ts", "nodenext", WORKER_TYPES_TSC_OPTIONS);
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      `typescript@${REPO_TYPESCRIPT_VERSION}`
    ],
    fixtureDir,
    installCommandTimeoutMs
  );
  logTypescriptVersion(fixtureDir, "api-cloudflare-service declarations, repo toolchain");
  runTsc(fixtureDir, "consumer.ts", "bundler", WORKER_TYPES_TSC_OPTIONS);
  runTsc(fixtureDir, "consumer.ts", "nodenext", WORKER_TYPES_TSC_OPTIONS);
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
  const rnTypes = `import { IAP as QueryIAP } from "${RN_PLATFORM_PACKAGE}";
import type { IapSubscriptionInfo } from "${packedPackage.name}";
export const historyQuery: (params?: { key?: string | null }) => Promise<unknown> = QueryIAP.getCompletedOrRefundedOrders;
export const subscriptionQuery: (args: { params: { orderId: string } }) => Promise<{ subscription: IapSubscriptionInfo } | undefined> = QueryIAP.getSubscriptionInfo;
// Type checks against the REAL @apps-in-toss/framework@${OFFICIAL_SDK_VERSIONS.rn} declarations.
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
  requestReview,
  grantPromotionReward,
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

export const promotionType: (input: { params: { promotionCode: string; amount: number } }) => Promise<
  { key: string } | { code: string } | { errorCode: string; message: string } | "ERROR" | undefined
> = grantPromotionReward;
export const reviewType: () => Promise<void> = requestReview;
export const reviewSupportType: () => boolean = requestReview.isSupported;
export const canary = { env, useGeolocation };
`;

  const webTypes = `import { IAP as QueryIAP } from "${WEB_PLATFORM_PACKAGE}";
import type { IapSubscriptionInfo } from "${packedPackage.name}";
export const historyQuery: () => Promise<unknown> = QueryIAP.getCompletedOrRefundedOrders;
export const subscriptionQuery: (args: { params: { orderId: string } }) => Promise<{ subscription: IapSubscriptionInfo }> = QueryIAP.getSubscriptionInfo;
// Type checks against the REAL @apps-in-toss/web-framework@${OFFICIAL_SDK_VERSIONS.web} declarations.
// Canary: TossAuth.isIntegrated exists in the official package but NOT in
// @ait-kit/sdk's ambient declaration — if the ambient masked the real
// types, this file would not compile.
import { Notification, Promotion, Review, Share, TossAuth, User, TossAds, loadFullScreenAd, showFullScreenAd } from "${WEB_PLATFORM_PACKAGE}";
import type { FullScreenAdSupport } from "${packedPackage.name}/webview";
export const adsContract: FullScreenAdSupport = { loadFullScreenAd, showFullScreenAd };
import type { WebViewBannerAdsOptions } from "${packedPackage.name}/webview";
export const bannerContract: WebViewBannerAdsOptions = { framework: { TossAds } };

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

export const promotionType: (input: { promotionCode: string; amount: number }) => Promise<{ key: string }> = Promotion.grantReward;
export const promotionSupportType: () => boolean = Promotion.grantReward.isSupported;
export const reviewType: () => Promise<void> = Review.request;
export const reviewSupportType: () => boolean = Review.request.isSupported;
export const canary = { isIntegrated: TossAuth.isIntegrated };
`;

  const rnRuntime = `import { SdkError } from "${packedPackage.name}";
import {
  createReactNativeIdentity,
  createReactNativeNotification,
  createReactNativePromotion,
  createReactNativeReview,
  createReactNativeShare,
  createReactNativeStorage
} from "${packedPackage.name}/rn";

// The stubbed native bridge rejects every call with this marker, proving
// the REAL official function ran (as opposed to an adapter stub).
const BRIDGE_ERROR = "native bridge unavailable in the tarball fixture";

// The fixture's own failure sentinel: must always escape the catch blocks
// below instead of being mistaken for an official-SDK rejection.
class FixtureFailure extends Error {}

function failIfAdapterError(error: unknown, label: string): void {
  if (error instanceof FixtureFailure) throw error;
  if (error instanceof SdkError) {
    throw new Error(\`\${label}: adapter produced \${error.code} (\${error.message}) instead of reaching the official SDK function\`);
  }
}

// For paths whose rejection is deterministic (the bridge stub rejects
// every awaited bridge call with the marker).
function expectBridgeRejection(error: unknown, label: string): void {
  failIfAdapterError(error, label);
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(BRIDGE_ERROR)) {
    throw new Error(\`\${label}: rejection did not come from the stubbed bridge: \${message}\`);
  }
}

(globalThis as { __appsInToss?: unknown }).__appsInToss = { brandDisplayName: "fixture" };
const review = createReactNativeReview();
if (!(await review.isSupported())) throw new FixtureFailure("review: expected support");
try {
  await review.request();
  throw new FixtureFailure("review: expected bridge rejection");
} catch (error) {
  expectBridgeRejection(error, "review");
}

// The real RN function maps the rejected synthetic bridge call to ERROR.
const promotion = createReactNativePromotion();
if (await promotion.getSupport() !== "unknown") throw new FixtureFailure("RN promotion support must be unknown without a checker");
const grant = await promotion.grantReward({ promotionCode: "SYNTHETIC", amount: 1 });
if (grant.status !== "unknown" || grant.reason !== "sdk_error") throw new FixtureFailure("RN promotion must preserve ambiguous bridge failure");

// 1. Identity: the real appLogin/getAnonymousKey run and their bridge
// rejections propagate with the marker — NOT a namespace-mismatch
// UNSUPPORTED.
const identity = createReactNativeIdentity();
try {
  await identity.login();
  throw new FixtureFailure("login: expected the stubbed bridge to reject");
} catch (error) {
  expectBridgeRejection(error, "login");
}
try {
  await identity.getAnonymousKey();
  throw new FixtureFailure("getAnonymousKey: expected the stubbed bridge to reject or resolve the ERROR sentinel");
} catch (error) {
  if (error instanceof FixtureFailure) throw error;
  // With the stubbed bridge the real function deterministically resolves
  // its documented "ERROR" sentinel (rejected by the shared validator as
  // INVALID_ANONYMOUS_KEY) or rejects with the bridge marker — both prove
  // the official function ran; the regression would be UNSUPPORTED.
  const isSentinel = error instanceof SdkError && error.code === "INVALID_ANONYMOUS_KEY";
  const isBridge = error instanceof Error && error.message.includes(BRIDGE_ERROR);
  if (!isSentinel && !isBridge) {
    throw new Error(\`getAnonymousKey: rejection did not come from the official function: \${String(error)}\`);
  }
}

// 2. Share link: positional arguments reach the real getTossShareLink.
const share = createReactNativeShare();
try {
  await share.createLink("intoss://fixture");
  throw new FixtureFailure("createLink: expected the stubbed bridge to reject");
} catch (error) {
  expectBridgeRejection(error, "createLink");
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
  throw new FixtureFailure(\`sendMessage: unexpected result \${JSON.stringify(sheetResult)}\`);
}

// 4. Notification: the real requestNotificationAgreement registers and
// the real SDK surfaces the stubbed bridge failure through onError,
// settling as failed with the marker (or, without the bridge error, by
// the request deadline) — never an adapter UNSUPPORTED.
const notification = createReactNativeNotification({ timeoutMs: 250 });
await notification.requestAgreement("TEMPLATE_1").then(
  (result) => {
    const settled =
      (result.status === "failed" && result.reason?.includes(BRIDGE_ERROR)) ||
      result.status === "timeout";
    if (!settled) {
      throw new FixtureFailure(\`requestAgreement: unexpected result \${JSON.stringify(result)}\`);
    }
  },
  (error) => {
    failIfAdapterError(error, "requestAgreement");
    throw new FixtureFailure("requestAgreement: expected the request to settle");
  }
);

// 5. Storage: the real namespaced Storage surface passes the adapter's
// all-or-nothing check and the bridge rejection propagates.
const storage = createReactNativeStorage();
try {
  await storage.get("fixture-key");
  throw new FixtureFailure("storage.get: expected the stubbed bridge to reject");
} catch (error) {
  expectBridgeRejection(error, "storage.get");
}
`;

  const webRuntime = `import { createWebViewBannerAds, createWebViewAds } from "${packedPackage.name}/webview";
import { SdkError } from "${packedPackage.name}";
import {
  createWebViewIdentity,
  createWebViewNotification,
  createWebViewPromotion,
  createWebViewReview,
  createWebViewShare,
  createWebViewStorage
} from "${packedPackage.name}/webview";

// Outside the Toss webview every official web SDK call throws the
// environment assertion — proving the real module loaded and the shared
// namespaced contract matched it. Defining window with the SDK's
// constants globals (modern app version so the SDK's own version gates
// pass) but WITHOUT the React Native WebView bridge routes every call
// through that assertion deterministically, instead of raw
// "window is not defined" ReferenceErrors.
(globalThis as { window?: unknown }).window = {
  ReactNativeWebView: null,
  __appsInToss: { ads: {
    initialize: Object.assign((options: { sdkVersion: string; callbacks: { onInitialized: () => void } }) => {
      if (options.sdkVersion !== "${OFFICIAL_SDK_VERSIONS.web}") throw new Error("banner: official SDK version was not injected");
      options.callbacks.onInitialized();
    }, { isSupported: () => true }),
    attachBanner: () => ({ destroy() { bannerDestroyCount++; } })
  } },
  __appsInTossConstants: {
    isLoadFullScreenAdSupported: true,
    isShowFullScreenAdSupported: true,
    isRequestReviewSupported: true,
    tossAppVersion: "9.9.9",
    operationalEnvironment: "toss",
    platformOS: "android"
  }
};
let bannerDestroyCount = 0;
const WEBVIEW_ERROR = "apps-in-toss 웹뷰 환경이 아니에요";

// The fixture's own failure sentinel: must always escape the catch blocks
// below instead of being mistaken for an official-SDK rejection.
class FixtureFailure extends Error {}

function expectWebviewRejection(error: unknown, label: string): void {
  if (error instanceof FixtureFailure) throw error;
  if (error instanceof SdkError) {
    throw new Error(\`\${label}: adapter produced \${error.code} (\${error.message}) instead of reaching the official SDK\`);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(WEBVIEW_ERROR)) {
    throw new Error(\`\${label}: rejection did not come from the official webview assertion: \${message}\`);
  }
}

const banners = createWebViewBannerAds();
const banner = await banners.attachBanner("SYNTHETIC", { nodeType: 1, namespaceURI: "http://www.w3.org/1999/xhtml" } as HTMLElement);
banner.destroy(); banner.destroy();
if (bannerDestroyCount !== 1) throw new FixtureFailure("banner: expected one owned handle cleanup");

const ads = createWebViewAds({ loadTimeoutMs: 250 });
try {
  await ads.loadFullScreenAd("SYNTHETIC");
  throw new FixtureFailure("ads: expected WebView rejection");
} catch (error) {
  // The official registration throws synchronously outside its host.
  expectWebviewRejection(error, "ads.load");
}
const promotion = createWebViewPromotion();
if (await promotion.getSupport() !== "supported") throw new FixtureFailure("WebView promotion should support the synthetic host version");
const grant = await promotion.grantReward({ promotionCode: "SYNTHETIC", amount: 1 });
if (grant.status !== "unknown" || grant.providerCode !== "UNKNOWN_ERROR") throw new FixtureFailure("WebView promotion must preserve the SDK unknown error");
const review = createWebViewReview();
if (!(await review.isSupported())) throw new FixtureFailure("review: expected support");
try {
  await review.request();
  throw new FixtureFailure("review: expected webview rejection");
} catch (error) {
  expectWebviewRejection(error, "review");
}
const identity = createWebViewIdentity();
try {
  await identity.login();
  throw new FixtureFailure("login: expected the webview assertion");
} catch (error) {
  expectWebviewRejection(error, "login");
}
try {
  await identity.getAnonymousKey();
  throw new FixtureFailure("getAnonymousKey: expected the webview assertion");
} catch (error) {
  // The official web SDK maps environment failures in the anonymous-key
  // path to its own documented unknown-error message instead of the raw
  // webview assertion (the "ERROR" sentinel equivalent) — both prove the
  // real function ran.
  if (error instanceof FixtureFailure) throw error;
  if (error instanceof SdkError) {
    throw new Error(\`getAnonymousKey: adapter produced \${error.code} (\${error.message}) instead of reaching the official SDK\`);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(WEBVIEW_ERROR) && !message.includes("사용자 키 조회")) {
    throw new Error(\`getAnonymousKey: rejection did not come from the official SDK: \${message}\`);
  }
}

const share = createWebViewShare();
try {
  await share.createLink("intoss://fixture");
  throw new FixtureFailure("createLink: expected the webview assertion");
} catch (error) {
  expectWebviewRejection(error, "createLink");
}
const sheetResult = await share.sendMessage("fixture message");
if (sheetResult.status !== "failed" || !sheetResult.reason?.includes(WEBVIEW_ERROR)) {
  throw new FixtureFailure(\`sendMessage: unexpected result \${JSON.stringify(sheetResult)}\`);
}

// The official Notification.requestAgreement asserts the webview during
// registration; the event flow surfaces that as a rejection (never an
// adapter UNSUPPORTED).
const notification = createWebViewNotification({ timeoutMs: 250 });
try {
  await notification.requestAgreement("TEMPLATE_1");
  throw new FixtureFailure("requestAgreement: expected the webview assertion");
} catch (error) {
  expectWebviewRejection(error, "requestAgreement");
}

const storage = createWebViewStorage();
try {
  await storage.get("fixture-key");
  throw new FixtureFailure("storage.get: expected the webview assertion");
} catch (error) {
  expectWebviewRejection(error, "storage.get");
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
    // Sync constants call: a modern app version so the SDK's own version
    // gates pass and every flow reaches the (rejecting) async bridge.
    if (prop === "getConstants") {
      return () => ({ tossAppVersion: "9.9.9" });
    }
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
    runTsc(fixtureDir, "official-types.ts", "bundler", { lib: fixture.tscLib, skipLibCheck: true });
    runTsc(fixtureDir, "official-types.ts", "nodenext", { lib: fixture.tscLib, skipLibCheck: true });
    runTsc(fixtureDir, "runtime.ts", "bundler", { lib: fixture.tscLib, skipLibCheck: true });
    run("npm", ["exec", "--", "esbuild", ...fixture.bundleArgs(fixtureDir)], fixtureDir);
    run(process.execPath, [join(fixtureDir, "runtime.bundle.mjs")], fixtureDir);
  }
}
