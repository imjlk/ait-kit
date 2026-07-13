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

    const importExport = manifest.exports?.["."]?.import;
    const typesExport = manifest.exports?.["."]?.types;
    if (
      typeof importExport !== "string" ||
      typeof typesExport !== "string" ||
      !importExport.startsWith("./") ||
      !typesExport.startsWith("./")
    ) {
      throw new Error(`${result.name} must define string exports["."].import and exports["."].types targets`);
    }
    for (const exportTarget of [importExport, typesExport]) {
      if (!files.has(exportTarget.replace(/^\.\//, "")) || !existsSync(join(packageDir, exportTarget))) {
        throw new Error(`${result.name} export does not exist in its tarball: ${exportTarget}`);
      }
    }
    packedPackages.push({
      name: result.name,
      version: result.version,
      tarballPath: join(tempDir, result.filename),
      manifest,
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
