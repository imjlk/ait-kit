// Shared mTLS contract scenarios for the /node transport. The scenarios are
// loaded from three verification targets that differ ONLY in how the module
// under test is loaded:
//
//   A. the repo-built dist (test/helpers/node-runtime-check.mjs),
//   B. an installed local tarball (scripts/test-package-tarballs.mjs),
//   C. an installed npm release (scripts/verify-published-node.mjs).
//
// The transport factory and the error class are always handed in FROM the
// module under test, so instanceof checks bind to the class the consumer
// actually loaded — never a mix of the repo class and the installed one.
//
// This module deliberately does NOT: choose repo dist paths, run npm
// installs, pick registry versions, rewrite public import specifiers,
// search for production certificates, or publish anything. Callers own
// module loading and certificate materials; every request goes to the
// caller-provided loopback test server only.

/**
 * @typedef {Object} MtlsContractCheckOptions
 * @property {typeof import("../../src/node").createNodeMtlsTransport} createNodeMtlsTransport
 *   Hand in from the module under test.
 * @property {typeof import("../../src/node").NodeMtlsTransportError} NodeMtlsTransportError
 *   Hand in from the SAME module so instanceof is never cross-contaminated.
 * @property {string} baseUrl Loopback mTLS test server base URL (https).
 * @property {string} ca CA certificate PEM (or a path — resolved by the caller).
 * @property {string} cert Client certificate PEM for the test server.
 * @property {string} key Client private key PEM. Never logged by this module.
 * @property {string} expectedClientCn The server echoes the peer certificate
 *   CN on /immediate; scenarios assert the server really saw this identity.
 * @property {number} [deadlineTimeoutMs=300] Transport timeoutMs for the
 *   overall-deadline scenario. Must stay well below scenarioTimeoutMs.
 * @property {number} [scenarioTimeoutMs=10000] Hard per-scenario budget.
 *   A transport that stays pending forever fails here instead of hanging
 *   the whole verification.
 */

/**
 * @param {MtlsContractCheckOptions} options
 * @returns {Promise<{pass: boolean, scenarios: Array<{name: string, ok: boolean, detail: string}>}>}
 *   Never throws for scenario failures; callers decide how to report and
 *   which exit code to use. Uncaught exceptions stay uncaught on purpose:
 *   no global handlers are installed, so a misbehaving transport fails the
 *   host process naturally through its exit code.
 */
export async function runMtlsContractChecks(options) {
  const {
    createNodeMtlsTransport,
    NodeMtlsTransportError,
    baseUrl,
    ca,
    cert,
    key,
    expectedClientCn,
    deadlineTimeoutMs = 300,
    scenarioTimeoutMs = 10_000
  } = options;

  if (
    typeof createNodeMtlsTransport !== "function" ||
    typeof NodeMtlsTransportError !== "function" ||
    typeof baseUrl !== "string" ||
    typeof ca !== "string" ||
    typeof cert !== "string" ||
    typeof key !== "string" ||
    typeof expectedClientCn !== "string"
  ) {
    throw new Error("runMtlsContractChecks: factory, error class, baseUrl, ca, cert, key and expectedClientCn are required");
  }

  /** @type {Array<{name: string, ok: boolean, detail: string}>} */
  const scenarios = [];
  const runScenario = async (name, body) => {
    let timer;
    try {
      const detail = await Promise.race([
        body(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`scenario exceeded its ${scenarioTimeoutMs}ms budget (pending transport?)`)),
            scenarioTimeoutMs
          );
        })
      ]);
      scenarios.push({ name, ok: true, detail });
    } catch (error) {
      clearTimeout(timer);
      scenarios.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  };

  // Asserts the rejection is the module's own typed error with the exact
  // code, and that the instance is a real Error (the runtime counterpart of
  // the type fixtures' constructor checks).
  const expectTransportError = (error, code, label) => {
    if (!(error instanceof NodeMtlsTransportError)) {
      throw new Error(`${label}: expected the module's NodeMtlsTransportError, got ${describe(error)}`);
    }
    if (!(error instanceof Error)) {
      throw new Error(`${label}: error instance is not an Error`);
    }
    if (error.code !== code) {
      throw new Error(`${label}: expected code ${code}, got ${describe(error.code)}`);
    }
    return error;
  };

  const transport = createNodeMtlsTransport({ ca, cert, key });

  // 1) Normal mutually authenticated request: status 200, the expected body,
  //    and proof the server verified the CLIENT certificate (peer CN).
  await runScenario("normal-200", async () => {
    const response = await transport.request(`${baseUrl}/immediate`, { method: "GET" });
    if (response.status !== 200) {
      throw new Error(`expected 200, got ${response.status}`);
    }
    const payload = await response.json();
    if (payload?.ok !== true) {
      throw new Error(`unexpected body: ${JSON.stringify(payload)}`);
    }
    if (payload?.clientCn !== expectedClientCn) {
      throw new Error(`server did not verify the client certificate: peer CN is ${JSON.stringify(payload?.clientCn)}`);
    }
    return `200, peer CN ${expectedClientCn}`;
  });

  // 2) Overall deadline: a request that never even sends headers must fail
  //    as TIMEOUT — never remapped to REQUEST_FAILED to sneak through.
  await runScenario("overall-deadline", async () => {
    const deadlined = createNodeMtlsTransport({ ca, cert, key, timeoutMs: deadlineTimeoutMs });
    try {
      await deadlined.request(`${baseUrl}/hang-headers`, { method: "GET" });
    } catch (error) {
      expectTransportError(error, "TIMEOUT", "hang-headers");
      return "TIMEOUT";
    }
    throw new Error("hang-headers resolved instead of hitting the overall deadline");
  });

  // 3) Broken body: headers arrive, the body breaks mid-flight. This must
  //    surface as REQUEST_FAILED, never as a partial success response.
  await runScenario("broken-body", async () => {
    let outcome;
    try {
      outcome = await transport.request(`${baseUrl}/break-body`, { method: "GET" });
    } catch (error) {
      expectTransportError(error, "REQUEST_FAILED", "break-body");
      return "REQUEST_FAILED";
    }
    throw new Error(`broken body resolved as a ${outcome.status} response instead of failing`);
  });

  // 4) Core regression — status 600: the completed body's fetch Response
  //    conversion throws (600 is outside the Fetch status range). The
  //    transport must reject as a typed REQUEST_FAILED with the original
  //    exception preserved as cause. Settling as TIMEOUT alone, leaking an
  //    uncaught exception, or staying pending (caught by the scenario
  //    budget) are all failures.
  await runScenario("status-600-conversion", async () => {
    let conversionError;
    try {
      await transport.request(`${baseUrl}/status?code=600`, { method: "GET" });
    } catch (error) {
      conversionError = error;
    }
    if (conversionError === undefined) {
      throw new Error("status 600 resolved instead of rejecting");
    }
    const typed = expectTransportError(conversionError, "REQUEST_FAILED", "status 600");
    if (!(typed.cause instanceof Error)) {
      throw new Error(`status 600 lost the original conversion exception as cause: ${describe(typed.cause)}`);
    }
    return `REQUEST_FAILED, cause preserved (${typed.cause.message})`;
  });

  // 5) Reuse after failure: the SAME transport instance keeps serving
  //    normal requests after the failures above.
  await runScenario("reuse-after-failure", async () => {
    const response = await transport.request(`${baseUrl}/immediate`, { method: "GET" });
    if (response.status !== 200) {
      throw new Error(`expected the post-failure request to return 200, got ${response.status}`);
    }
    return "200";
  });

  return { pass: scenarios.every((scenario) => scenario.ok), scenarios };
}

function describe(value) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}
