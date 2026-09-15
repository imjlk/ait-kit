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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commandTimeoutMs = positiveTimeout(process.env.AIT_PACKAGE_SMOKE_TIMEOUT_MS, 120_000);
const installCommandTimeoutMs = positiveTimeout(process.env.AIT_PACKAGE_INSTALL_TIMEOUT_MS, 300_000);
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
      // Per-platform fixtures: each installs the real tarball plus a stub of
      // ONLY its own platform SDK, proving the two entries stay independent
      // (an /rn consumer never needs the web SDK and vice versa, in JS or
      // in the shipped declarations), then type-checks (bundler + NodeNext),
      // bundles, and executes the consumer against the installed package.
      const platforms = [
        {
          subpath: "rn",
          platformPackage: "@apps-in-toss/framework",
          externalFlag: "--external:@apps-in-toss/framework",
          consumerImports: `import {
  createReactNativeAds,
  createReactNativeIdentity,
  createReactNativeIap,
  createReactNativeStorage
} from ${JSON.stringify(`${packedPackage.name}/rn`)};`,
          consumerBody: `export const ads = createReactNativeAds();
export const iap = createReactNativeIap({ grant: async () => {} });
export const identity = createReactNativeIdentity();
export const storage = createReactNativeStorage();
export async function crossEntryInstanceofCheck(): Promise<boolean> {
  try {
    await iap.getPendingOrders();
    return false;
  } catch (error) {
    return error instanceof SdkError;
  }
}

// Executed by the fixture runner: must hold against the installed tarball.
if (!(await crossEntryInstanceofCheck())) {
  throw new Error("cross-entry SdkError instanceof check failed");
}
`
        },
        {
          subpath: "web",
          platformPackage: "@apps-in-toss/web-framework",
          externalFlag: "--external:@apps-in-toss/web-framework",
          consumerImports: `import {
  createWebIap,
  createWebIdentity,
  createWebStorage
} from ${JSON.stringify(`${packedPackage.name}/web`)};`,
          consumerBody: `export const iap = createWebIap({ grant: async () => {} });
export const identity = createWebIdentity();
export const storage = createWebStorage();
export async function crossEntryInstanceofCheck(): Promise<boolean> {
  try {
    await iap.getPendingOrders();
    return false;
  } catch (error) {
    return error instanceof SdkError;
  }
}

// Executed by the fixture runner: must hold against the installed tarball.
if (!(await crossEntryInstanceofCheck())) {
  throw new Error("cross-entry SdkError instanceof check failed");
}
`
        }
      ];

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
            packedPackage.tarballPath,
            "typescript@6.0.3",
            "esbuild@0.28.2",
            stubDir
          ],
          fixtureDir,
          installCommandTimeoutMs
        );
        run(
          "npm",
          [
            "exec",
            "--",
            "tsc",
            "--noEmit",
            "--strict",
            "--target",
            "es2022",
            "--module",
            "esnext",
            "--moduleResolution",
            "bundler",
            "consumer.ts"
          ],
          fixtureDir
        );
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
        run(
          "npm",
          [
            "exec",
            "--",
            "tsc",
            "--noEmit",
            "--strict",
            "--target",
            "es2022",
            "--module",
            "nodenext",
            "--moduleResolution",
            "nodenext",
            "consumer.ts"
          ],
          fixtureDir
        );
        // Execute the bundled consumer: the cross-entry instanceof check
        // must hold at runtime against the installed tarball (the stub IAP
        // makes the adapter reject with a root SdkError).
        run(process.execPath, [join(fixtureDir, "consumer.js")], fixtureDir);
      }
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
