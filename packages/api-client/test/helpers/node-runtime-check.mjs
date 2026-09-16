// Node client-runtime check for the /node transport, run as a child process
// against the BUILT dist output (never the TypeScript source). The parent
// test asserts a zero exit code; any uncaught exception fails naturally via
// the process exit code, so no global handlers are installed.
//
// Usage: node node-runtime-check.mjs <baseUrl> <caPath> <certPath> <keyPath>
import { readFileSync } from "node:fs";
import {
  createNodeMtlsTransport,
  NodeMtlsTransportError
} from "../../dist/node/index.js";

const [baseUrl, caPath, certPath, keyPath] = process.argv.slice(2);
if (!baseUrl || !caPath || !certPath || !keyPath) {
  throw new Error("usage: node-runtime-check.mjs <baseUrl> <caPath> <certPath> <keyPath>");
}

const transport = createNodeMtlsTransport({
  cert: readFileSync(certPath, "utf8"),
  key: readFileSync(keyPath, "utf8"),
  ca: readFileSync(caPath, "utf8")
});

// 1) Normal mutually authenticated request.
const ok = await transport.request(`${baseUrl}/immediate`, { method: "GET" });
if (ok.status !== 200) {
  throw new Error(`expected the normal request to return 200, got ${ok.status}`);
}

// 2) Core regression: a completed body whose fetch Response conversion
//    throws (status 600 is outside the Fetch status range) must reject as a
//    typed REQUEST_FAILED with the original exception preserved as cause —
//    never an uncaught exception, a TIMEOUT, or a pending promise.
let conversionError;
try {
  await transport.request(`${baseUrl}/status?code=600`, { method: "GET" });
} catch (error) {
  conversionError = error;
}
if (
  !(conversionError instanceof NodeMtlsTransportError) ||
  conversionError.code !== "REQUEST_FAILED" ||
  !(conversionError.cause instanceof Error)
) {
  throw new Error(
    `status 600 did not reject as a typed conversion failure: ${String(conversionError)}`
  );
}

// 3) The same transport instance keeps serving requests after the failure.
const next = await transport.request(`${baseUrl}/immediate`, { method: "GET" });
if (next.status !== 200) {
  throw new Error(`expected the post-failure request to return 200, got ${next.status}`);
}

console.log("PASS");
