// Verifies an npm-RELEASE build of @ait-kit/api-client's /node transport
// through the same shared mTLS contract scenarios used for the repo build
// and the local-tarball checks. Explicitly requested only — it is never a
// mandatory CI gate, because the PR under test is not published yet.
//
// Usage:
//   bun run verify:published:node -- --version <exact-version> [--report <path>] [--registry <url>]
//
// The command ONLY installs and verifies. It never publishes, never reruns
// workflows, never creates tags, and never touches repository build output
// (no dist replacement, no symlinks into the workspace).
//
// Failure phases are kept distinguishable: resolve (registry lookup),
// install (npm install), verify (installed manifests / module resolution),
// and contract (the mTLS scenarios). Registry lookups retry ONLY for
// not-yet-propagated versions and transient network errors, with a finite
// budget; permission, integrity, and unknown-package errors fail
// immediately. A failed contract check is never retried.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { repoFileUrl, startMtlsServer } from "./lib/start-mtls-server.mjs";

const PACKAGE_NAME = "@ait-kit/api-client";
const ENTRYPOINT = `${PACKAGE_NAME}/node`;
const CLIENT_CN = "ait-kit-verify-client";
// Finite retry budget for registry propagation delay: 5 attempts, 10s apart
// (~40s of waiting total), then the run fails as a resolve error.
const RESOLVE_ATTEMPTS = 5;
const RESOLVE_RETRY_DELAY_MS = 10_000;
// Finite budget for the whole consumer child (install→scenario run).
const CHILD_TIMEOUT_MS = positiveIntEnv("AIT_PUBLISHED_VERIFY_TIMEOUT_MS", 120_000);

class VerificationError extends Error {
  constructor(phase, message, options) {
    super(message, options);
    this.name = "VerificationError";
    this.phase = phase; // "resolve" | "install" | "verify" | "contract"
  }
}

/**
 * Accepts ONLY exact versions (optionally with an explicit prerelease):
 * 0.4.1, 1.2.3-beta.1. Rejects ranges (^, ~, >, <, *, x-ranges), dist-tags
 * (latest), and anything else npm might reinterpret to a different release.
 */
export function parseExactVersion(value) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+)?$/.test(value.trim())) {
    throw new VerificationError(
      "resolve",
      `--version must be an exact version (e.g. 0.4.1); got ${JSON.stringify(value)}`
    );
  }
  return value.trim();
}

/**
 * Minimal semver satisfies for the shapes this repo publishes internally
 * (exact, ^, ~). Not a general semver implementation.
 */
export function satisfiesSimpleSemver(version, range) {
  const exact = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(range.trim());
  if (exact) return version === exact[1];
  const comparator = /^([\^~])v?(\d+)\.(\d+)\.(\d+)/.exec(range.trim());
  if (!comparator) {
    throw new VerificationError("verify", `unsupported internal dependency range: ${range}`);
  }
  const [, operator, majorRaw, minorRaw, patchRaw] = comparator;
  const [major, minor, patch] = [majorRaw, minorRaw, patchRaw].map(Number);
  const parts = version.split("-")[0].split(".").map(Number);
  const [vMajor, vMinor, vPatch] = parts;
  const below = vMajor < major || (vMajor === major && vMinor < minor) || (vMajor === major && vMinor === minor && vPatch < patch);
  if (below) return false;
  if (operator === "~") {
    return vMajor === major && vMinor === minor;
  }
  // caret: 0.0.x pins exactly; 0.x.y allows patch within the minor; >=1
  // allows anything within the major.
  if (major === 0 && minor === 0) {
    return vMajor === 0 && vMinor === 0 && vPatch === patch;
  }
  if (major === 0) {
    return vMajor === 0 && vMinor === minor;
  }
  return vMajor === major;
}

/** True when the resolved module file lives inside the given install root. */
export function isInsideDirectory(filePath, directory) {
  const rel = relative(directory, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function run(command, args, cwd, timeoutMs) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs });
  if (result.error?.code === "ETIMEDOUT") {
    throw new VerificationError("install", `${command} ${args.join(" ")} timed out after ${timeoutMs / 1000}s`);
  }
  if (result.error) {
    throw new VerificationError("install", `${command} ${args.join(" ")} failed to spawn: ${result.error.message}`);
  }
  return result;
}

async function resolveRegistryMetadata(version, registry) {
  let lastOutput = "";
  for (let attempt = 1; attempt <= RESOLVE_ATTEMPTS; attempt += 1) {
    const result = run(
      "npm",
      ["view", `${PACKAGE_NAME}@${version}`, "version", "dist.tarball", "--registry", registry, "--json"],
      undefined,
      60_000
    );
    if (result.status === 0) {
      return JSON.parse(result.stdout);
    }
    lastOutput = `${result.stdout || ""}${result.stderr || ""}`;
    // Retry ONLY propagation-style misses and transient transport errors.
    // Permission (E401/E403), integrity (EINTEGRITY), and anything unknown
    // fail immediately — never infinite, never a fallback version.
    const transient = /E404|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network/i.test(lastOutput);
    if (!transient || attempt === RESOLVE_ATTEMPTS) {
      throw new VerificationError(
        "resolve",
        `npm view ${PACKAGE_NAME}@${version} failed (status ${result.status})${
          transient ? ` after ${RESOLVE_ATTEMPTS} attempts` : ""
        }: ${lastOutput.trim().slice(0, 500)}`
      );
    }
    console.log(`registry has not surfaced ${PACKAGE_NAME}@${version} yet; retrying (${attempt}/${RESOLVE_ATTEMPTS})...`);
    await new Promise((resolve) => setTimeout(resolve, RESOLVE_RETRY_DELAY_MS));
  }
  throw new VerificationError("resolve", "unreachable");
}

function writeConsumerRunner(projectDir) {
  const runnerPath = join(projectDir, "verify-node-entrypoint.mjs");
  writeFileSync(
    runnerPath,
    'import { readFileSync, realpathSync } from "node:fs";\n' +
      'import { sep } from "node:path";\n' +
      'import { fileURLToPath } from "node:url";\n' +
      `import { createNodeMtlsTransport, NodeMtlsTransportError } from ${JSON.stringify(ENTRYPOINT)};\n` +
      "import { runMtlsContractChecks } from " +
      JSON.stringify(repoFileUrl("packages/api-client/test/helpers/mtls-contract-check.mjs")) +
      ";\n\n" +
      "const [baseUrl, caPath, certPath, keyPath, installRoot] = process.argv.slice(2);\n" +
      "// Record WHAT the public entrypoint actually resolved to in this\n" +
      "// consumer project, and prove it lives inside the installed package —\n" +
      "// a path back into the repository workspace means the check targeted\n" +
      "// the wrong module and must fail.\n" +
      "const resolvedUrl = import.meta.resolve(" + JSON.stringify(ENTRYPOINT) + ");\n" +
      "const resolvedPath = realpathSync(fileURLToPath(resolvedUrl));\n" +
      "const insideInstallRoot = resolvedPath.startsWith(realpathSync(installRoot) + sep);\n" +
      "const result = await runMtlsContractChecks({\n" +
      "  createNodeMtlsTransport,\n" +
      "  NodeMtlsTransportError,\n" +
      "  baseUrl,\n" +
      '  ca: readFileSync(caPath, "utf8"),\n' +
      '  cert: readFileSync(certPath, "utf8"),\n' +
      '  key: readFileSync(keyPath, "utf8"),\n' +
      `  expectedClientCn: ${JSON.stringify(CLIENT_CN)}\n` +
      "});\n" +
      "console.log(JSON.stringify({ resolvedUrl, resolvedPath, insideInstallRoot, result }));\n" +
      "process.exit(result.pass && insideInstallRoot ? 0 : 1);\n"
  );
  return runnerPath;
}

export async function verifyPublishedNodeTransport({ version, registry, reportPath, onLog = () => {} }) {
  const exact = parseExactVersion(version);
  const report = {
    timestamp: new Date().toISOString(),
    mode: "registry",
    registry,
    requestedVersion: exact,
    entrypoint: ENTRYPOINT,
    runtime: {
      node: process.version,
      bun: process.versions.bun ?? null,
      childRuntime: "node"
    },
    // The commit of THIS verification tooling — deliberately separate from
    // the release commit of the package under test, which npm metadata
    // cannot confirm for us.
    verificationCommit: currentCommit(),
    releaseCommit: "unknown",
    scenarios: null,
    child: null,
    overall: "fail"
  };

  let projectDir;
  let mtls;
  try {
    onLog(`resolving ${PACKAGE_NAME}@${exact} on ${registry}...`);
    const metadata = await resolveRegistryMetadata(exact, registry);
    report.registryTarball = typeof metadata?.["dist.tarball"] === "string" ? metadata["dist.tarball"] : null;

    // Isolated consumer project OUTSIDE the repository.
    projectDir = mkdtempSync(join(tmpdir(), "ait-kit-published-verify-"));
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2));
    onLog(`installing ${PACKAGE_NAME}@${exact} into an isolated consumer project...`);
    const install = run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-package-lock",
        "--no-audit",
        "--no-fund",
        "--registry",
        registry,
        `${PACKAGE_NAME}@${exact}`
      ],
      projectDir,
      CHILD_TIMEOUT_MS
    );
    if (install.status !== 0) {
      throw new VerificationError(
        "install",
        `npm install ${PACKAGE_NAME}@${exact} failed (status ${install.status}):\n${(install.stderr || install.stdout || "").slice(-2000)}`
      );
    }

    // Installed manifests: the installed api-client must BE the requested
    // release, and api-core must satisfy what that release declares.
    const clientDir = join(projectDir, "node_modules", PACKAGE_NAME);
    const coreDir = join(projectDir, "node_modules", "@ait-kit", "api-core");
    if (!existsSync(join(clientDir, "package.json")) || !existsSync(join(coreDir, "package.json"))) {
      throw new VerificationError("verify", "installed node_modules is missing the api-client or api-core manifest");
    }
    const clientManifest = JSON.parse(readFileSync(join(clientDir, "package.json"), "utf8"));
    const coreManifest = JSON.parse(readFileSync(join(coreDir, "package.json"), "utf8"));
    report.installedClientVersion = clientManifest.version;
    report.installedCoreVersion = coreManifest.version;
    report.clientName = clientManifest.name;
    report.coreRequirement = clientManifest.dependencies?.["@ait-kit/api-core"] ?? null;
    if (clientManifest.name !== PACKAGE_NAME || clientManifest.version !== exact) {
      throw new VerificationError(
        "verify",
        `installed ${clientManifest.name}@${clientManifest.version}, expected ${PACKAGE_NAME}@${exact}`
      );
    }
    if (typeof report.coreRequirement !== "string" || !satisfiesSimpleSemver(coreManifest.version, report.coreRequirement)) {
      throw new VerificationError(
        "verify",
        `installed @ait-kit/api-core@${coreManifest.version} does not satisfy the release requirement ${report.coreRequirement}`
      );
    }

    onLog("booting the loopback mTLS verification server...");
    mtls = await startMtlsServer({ clientCn: CLIENT_CN });
    const runnerPath = writeConsumerRunner(projectDir);

    onLog("running the shared mTLS contract scenarios against the installed release...");
    const child = spawnSync(
      process.execPath.includes("bun") ? "node" : process.execPath,
      [runnerPath, mtls.baseUrl, mtls.caPath, mtls.certPath, mtls.keyPath, clientDir],
      { cwd: projectDir, encoding: "utf8", timeout: CHILD_TIMEOUT_MS }
    );
    const timedOut = child.error?.code === "ETIMEDOUT";
    report.child = {
      exitCode: child.status,
      signal: child.signal,
      timedOut,
      stdout: (child.stdout || "").slice(-4000),
      stderr: (child.stderr || "").slice(-4000)
    };

    if (child.error && !timedOut) {
      throw new VerificationError("contract", `consumer failed to spawn: ${child.error.message}`);
    }
    if (timedOut) {
      throw new VerificationError("contract", `consumer exceeded its ${CHILD_TIMEOUT_MS / 1000}s budget (watchdog kill)`);
    }
    if (child.status !== 0) {
      throw new VerificationError("contract", `consumer exited with ${child.status ?? `signal ${child.signal}`}`);
    }

    // Parse the consumer's JSON result — success is decided from the actual
    // scenario outcomes and module resolution, never from message text.
    const payload = JSON.parse((child.stdout || "").trim().split("\n").pop());
    report.moduleResolution = {
      requestedSpecifier: ENTRYPOINT,
      resolvedUrl: payload.resolvedUrl,
      resolvedPath: payload.resolvedPath,
      insideInstallRoot: payload.insideInstallRoot
    };
    report.scenarios = payload.result?.scenarios ?? null;
    // Belt and braces: the parent re-checks the resolution claim.
    if (!payload.insideInstallRoot || !isInsideDirectory(payload.resolvedPath, realpathSync(clientDir))) {
      throw new VerificationError("verify", `resolved module is not inside the installed package: ${payload.resolvedPath}`);
    }
    if (payload.result?.pass !== true) {
      throw new VerificationError("contract", "one or more mTLS contract scenarios failed");
    }

    report.overall = "pass";
    return report;
  } catch (error) {
    if (error instanceof VerificationError) {
      report.failurePhase = error.phase;
      report.failureMessage = error.message;
    } else {
      report.failurePhase = "internal";
      report.failureMessage = error instanceof Error ? error.message : String(error);
    }
    error.report = report;
    throw error;
  } finally {
    // Every helper, timer, and temporary directory is torn down on BOTH
    // success and failure; the report (when requested) survives below.
    try {
      await mtls?.close();
    } catch {
      // close() already force-kills after its graceful window; a second
      // failure must not mask the original verification error.
    }
    if (projectDir) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  }
}

function currentCommit() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function positiveIntEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parseCliArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") {
      options.version = argv[i + 1];
      i += 1;
    } else if (arg === "--report") {
      options.reportPath = argv[i + 1];
      i += 1;
    } else if (arg === "--registry") {
      options.registry = argv[i + 1];
      i += 1;
    } else {
      throw new VerificationError("resolve", `unknown argument: ${arg}`);
    }
  }
  return options;
}

export function defaultRegistry() {
  const result = spawnSync("npm", ["config", "get", "registry"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "https://registry.npmjs.org/";
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options.version) {
    console.error("usage: verify-published-node.mjs --version <exact-version> [--report <path>] [--registry <url>]");
    process.exit(2);
  }
  const registry = options.registry ?? defaultRegistry();
  console.log(`registry: ${registry} (default; user config is not modified)`);
  let report;
  try {
    report = await verifyPublishedNodeTransport({ version: options.version, registry, reportPath: options.reportPath, onLog: (m) => console.log(m) });
  } catch (error) {
    report = error.report ?? null;
    const phase = error instanceof VerificationError ? error.phase : "internal";
    console.error(`FAILED [${phase}] ${error instanceof Error ? error.message : String(error)}`);
    if (options.reportPath) {
      writeReport(options.reportPath, report);
    }
    process.exit(1);
  }
  for (const scenario of report.scenarios ?? []) {
    console.log(`  ${scenario.ok ? "PASS" : "FAIL"} ${scenario.name}${scenario.ok ? "" : `: ${scenario.detail}`}`);
  }
  console.log(
    `PASS ${PACKAGE_NAME}@${report.installedClientVersion} (api-core ${report.installedCoreVersion}) ` +
      `resolved to ${report.moduleResolution.resolvedPath}`
  );
  if (options.reportPath) {
    writeReport(options.reportPath, report);
  }
}

function writeReport(reportPath, report) {
  if (!report) {
    // Even a pre-report failure leaves a trace, but never a fabricated pass.
    writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), overall: "fail", reportAvailable: false }, null, 2));
    return;
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`report written to ${reportPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main();
}
