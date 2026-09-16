// Regression tests for the published-package verification TOOL itself:
// every case here must FAIL (or reject) exactly the way the tool promises,
// using explicit LOCAL fixtures only. The contract fixtures below never
// touch the npm registry and never substitute for the real
// `verify:published:node` run — the two execution paths stay separate.
//
// Run by scripts/test-package-tarballs.mjs as part of the ordinary PR CI.
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isInsideDirectory,
  parseExactVersion,
  satisfiesSimpleSemver,
  verifyPublishedNodeTransport
} from "./verify-published-node.mjs";
import { startMtlsServer } from "./lib/start-mtls-server.mjs";
import { runMtlsContractChecks } from "../packages/api-client/test/helpers/mtls-contract-check.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const failures = [];
let passed = 0;

function check(name, body) {
  return Promise.resolve()
    .then(body)
    .then(() => {
      passed += 1;
      console.log(`  PASS ${name}`);
    })
    .catch((error) => {
      failures.push(name);
      console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    });
}

/** Snapshot of temp dirs with a given prefix — used to prove cleanup. */
function tmpSnapshot(prefix) {
  return new Set(readdirSync(tmpdir()).filter((entry) => entry.startsWith(prefix)));
}

// ---------------------------------------------------------------------------
// 1+2. Version input validation: exact versions only, ranges/tags rejected.
// ---------------------------------------------------------------------------
await check("rejects missing, range, and dist-tag versions", async () => {
  const bad = [undefined, "", "latest", "next", "^0.4.1", "~0.4.1", ">=0.4.0", "0.4.x", "0.4", "0.4.1 || 0.5.0", "*"];
  for (const value of bad) {
    try {
      parseExactVersion(value);
    } catch {
      continue;
    }
    throw new Error(`accepted invalid version ${JSON.stringify(value)}`);
  }
});
await check("accepts exact and prerelease versions", async () => {
  if (parseExactVersion("0.4.1") !== "0.4.1") throw new Error("exact version mangled");
  if (parseExactVersion(" 1.2.3-beta.1 ") !== "1.2.3-beta.1") throw new Error("prerelease mangled");
});

// ---------------------------------------------------------------------------
// 3. Installed-vs-requested comparison primitive (the manifest equality and
//    the api-core requirement check are driven by it).
// ---------------------------------------------------------------------------
await check("semver satisfaction matches the internal ranges", async () => {
  const cases = [
    ["0.4.1", "0.4.1", true],
    ["0.4.2", "0.4.1", false],
    ["0.4.2", "^0.4.1", true],
    ["0.4.0", "^0.4.1", false],
    ["0.5.0", "^0.4.1", false],
    ["0.4.9", "~0.4.1", true],
    ["0.5.0", "~0.4.1", false],
    ["0.0.2", "^0.0.1", false],
    ["1.9.0", "^1.2.3", true],
    ["2.0.0", "^1.2.3", false],
    ["0.4.2-beta.1", "^0.4.1", false],
    ["1.2.3-beta.1", "1.2.3-beta.1", true]
  ];
  for (const [version, range, expected] of cases) {
    if (satisfiesSimpleSemver(version, range) !== expected) {
      throw new Error(`satisfiesSimpleSemver(${version}, ${range}) !== ${expected}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Wrong-target protection: workspace/repository paths are outside.
// ---------------------------------------------------------------------------
await check("module containment rejects workspace and repo paths", async () => {
  const installRoot = "/tmp/consumer/node_modules/@ait-kit/api-client";
  if (!isInsideDirectory(join(installRoot, "dist/node/index.js"), installRoot)) {
    throw new Error("file inside install root reported as outside");
  }
  if (isInsideDirectory("/Users/dev/repos/ait-kit/packages/api-client/dist/node/index.js", installRoot)) {
    throw new Error("repository path reported as inside the install root");
  }
  if (isInsideDirectory("/etc/passwd", installRoot)) {
    throw new Error("unrelated absolute path reported as inside");
  }
  if (isInsideDirectory(installRoot, installRoot)) {
    throw new Error("the install root itself must not count as inside");
  }
});

// ---------------------------------------------------------------------------
// 5-8. The shared scenarios must FAIL bad transports. Local fixtures only:
//      a fake module (factory + error class handed in together, exactly like
//      the real targets) with scripted per-route behavior.
// ---------------------------------------------------------------------------
class FakeTransportError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "FakeTransportError";
    this.code = code;
  }
}

const okResponse = () =>
  Promise.resolve(
    new Response(JSON.stringify({ clientCn: "fake-client", ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    })
  );
const conversionFailure = () =>
  Promise.reject(
    new FakeTransportError("REQUEST_FAILED", "failed to convert the completed response into a fetch Response", {
      cause: new Error("Response constructor threw")
    })
  );
const timeoutFailure = () => Promise.reject(new FakeTransportError("TIMEOUT", "deadline exceeded"));
const neverSettles = () => new Promise(() => {});

const ROUTES = {
  "/immediate": { good: okResponse },
  "/hang-headers": { good: timeoutFailure, "wrong-timeout": conversionFailure, "never-settles": neverSettles },
  "/break-body": { good: conversionFailure },
  "/status": {
    good: conversionFailure,
    "wrong-600-error": timeoutFailure,
    "lost-cause": () =>
      Promise.reject(new FakeTransportError("REQUEST_FAILED", "conversion failed without a cause"))
  }
};

const scenarioFixtures = [
  { mode: "good", expect: "pass", label: "a correct module passes every scenario" },
  { mode: "wrong-600-error", expect: "fail:status-600-conversion", label: "200 works but status 600 returns the WRONG typed error" },
  { mode: "lost-cause", expect: "fail:status-600-conversion", label: "conversion error loses the original cause" },
  { mode: "wrong-timeout", expect: "fail:overall-deadline", label: "hang-headers rejects with REQUEST_FAILED instead of TIMEOUT" },
  { mode: "never-settles", expect: "fail:overall-deadline", label: "a transport that never settles is stopped by the scenario budget" }
];

for (const fixture of scenarioFixtures) {
  await check(`scenario detects: ${fixture.label}`, async () => {
    const request = (url) => {
      const behaviors = ROUTES[new URL(url).pathname];
      // A fixture mode that does not override this route keeps the good
      // behavior, so each broken fixture fails on exactly one scenario.
      const behavior = behaviors[fixture.mode] ?? behaviors.good;
      return behavior();
    };
    const result = await runMtlsContractChecks({
      createNodeMtlsTransport: () => ({ request }),
      NodeMtlsTransportError: FakeTransportError,
      baseUrl: "https://fixture.invalid",
      ca: "ca",
      cert: "cert",
      key: "key",
      expectedClientCn: "fake-client",
      deadlineTimeoutMs: 100,
      scenarioTimeoutMs: 1_500
    });
    if (fixture.expect === "pass") {
      if (!result.pass) {
        throw new Error(`expected the correct module to pass, got: ${JSON.stringify(result.scenarios.filter((s) => !s.ok))}`);
      }
      return;
    }
    const scenarioName = fixture.expect.split(":")[1];
    const scenario = result.scenarios.find((s) => s.name === scenarioName);
    const failed = result.scenarios.filter((s) => !s.ok);
    if (result.pass || !scenario || scenario.ok) {
      throw new Error(`expected scenario ${scenarioName} to fail, got: ${JSON.stringify(result.scenarios)}`);
    }
    // Each broken fixture overrides exactly one route: pin that only the
    // targeted scenario fails, so the fixtures cannot silently broaden.
    if (failed.length !== 1) {
      throw new Error(`expected exactly one failing scenario, got: ${JSON.stringify(failed)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// 9. Child/CLI misbehavior: the real command, end to end, must exit non-zero
//    and name the failing phase.
// ---------------------------------------------------------------------------
await check("CLI exits non-zero and reports the resolve phase for an unknown version", async () => {
  const result = spawnSync(
    process.execPath,
    [join(here, "verify-published-node.mjs"), "--version", "99.99.99", "--registry", "https://registry.npmjs.org/"],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, AIT_PUBLISHED_RESOLVE_ATTEMPTS: "1" } }
  );
  if (result.status === 0) {
    throw new Error(`CLI exited 0 for an unknown version: ${result.stdout}${result.stderr}`);
  }
  if (!/FAILED \[resolve\]/.test(result.stderr || "")) {
    throw new Error(`CLI did not report the resolve phase: ${result.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// 10+11. Server startup failure and post-failure resource cleanup.
// ---------------------------------------------------------------------------
await check("server material generation failure propagates and cleans the temp dir", async () => {
  const before = tmpSnapshot("ait-kit-mtls-verify-");
  const previousPath = process.env.PATH;
  process.env.PATH = "/nonexistent-ait-kit-selftest";
  try {
    let failed;
    try {
      await startMtlsServer();
    } catch (error) {
      failed = error;
    }
    if (!failed) throw new Error("expected certificate generation to fail without openssl on PATH");
  } finally {
    process.env.PATH = previousPath;
  }
  const leaked = [...tmpSnapshot("ait-kit-mtls-verify-")].filter((entry) => !before.has(entry));
  if (leaked.length > 0) {
    for (const entry of leaked) rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    throw new Error(`temp key-material directories leaked after failure: ${leaked.join(", ")}`);
  }
});

await check("resolve failure reports the resolve phase and cleans temporary state", async () => {
  // An unknown version on the REAL registry fails during resolve (E404,
  // single attempt) — the consumer project may or may not exist yet, and
  // nothing may be left behind either way.
  const before = [...tmpSnapshot("ait-kit-published-verify-"), ...tmpSnapshot("ait-kit-mtls-verify-")];
  let report;
  try {
    await verifyPublishedNodeTransport({
      version: "99.99.99",
      registry: "https://registry.npmjs.org/",
      resolveAttempts: 1
    });
    throw new Error("expected the unknown-version resolve to fail");
  } catch (error) {
    report = error.report;
    if (!report || report.failurePhase !== "resolve") {
      throw new Error(`unexpected failure phase: ${report?.failurePhase} (${report?.failureMessage})`);
    }
  }
  const leaked = [...tmpSnapshot("ait-kit-published-verify-"), ...tmpSnapshot("ait-kit-mtls-verify-")].filter(
    (entry) => !before.has(entry)
  );
  if (leaked.length > 0) {
    for (const prefix of ["ait-kit-published-verify-", "ait-kit-mtls-verify-"]) {
      for (const entry of leaked.filter((e) => e.startsWith(prefix))) {
        rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      }
    }
    throw new Error(`temporary directories leaked after the failure: ${leaked.join(", ")}`);
  }
});

console.log(`selftest: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(`selftest failures:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
