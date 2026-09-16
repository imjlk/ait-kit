// Node client-runtime check for the /node transport, run as a child process
// against the BUILT dist output (never the TypeScript source). The parent
// test asserts a zero exit code; any uncaught exception fails naturally via
// the process exit code, so no global handlers are installed.
//
// Thin entry point: it only loads the built module, hands it to the shared
// contract scenarios, and maps the result to an exit code. The scenarios
// themselves live in mtls-contract-check.mjs and are shared with the
// tarball and npm-release verification targets.
//
// Usage: node node-runtime-check.mjs <baseUrl> <caPath> <certPath> <keyPath>
import { readFileSync } from "node:fs";
import {
  createNodeMtlsTransport,
  NodeMtlsTransportError
} from "../../dist/node/index.js";
import { runMtlsContractChecks } from "./mtls-contract-check.mjs";

const [baseUrl, caPath, certPath, keyPath] = process.argv.slice(2);
if (!baseUrl || !caPath || !certPath || !keyPath) {
  throw new Error("usage: node-runtime-check.mjs <baseUrl> <caPath> <certPath> <keyPath>");
}

const result = await runMtlsContractChecks({
  createNodeMtlsTransport,
  NodeMtlsTransportError,
  baseUrl,
  // Private materials are read from the temporary files the test server
  // generated; they are never printed.
  ca: readFileSync(caPath, "utf8"),
  cert: readFileSync(certPath, "utf8"),
  key: readFileSync(keyPath, "utf8"),
  expectedClientCn: "ait-kit-test-client"
});

if (!result.pass) {
  for (const scenario of result.scenarios) {
    if (!scenario.ok) {
      console.error(`FAIL ${scenario.name}: ${scenario.detail}`);
    }
  }
  process.exit(1);
}

console.log("PASS");
