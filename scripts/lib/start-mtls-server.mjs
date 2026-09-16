// Boots the repo's Node mTLS test server (real client-certificate
// enforcement, packages/api-client/test/helpers/mtls-test-server.mjs) with
// fresh OpenSSL materials for consumer verification: the installed-tarball
// checks and the npm-registry checks below. The server is test
// infrastructure running from the repository; only the TRANSPORT under test
// runs from the installed package.
//
// Private materials stay in the generated temporary directory and are
// exposed as file PATHS — never as argv strings, error messages, or reports.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * @param {object} [options]
 * @param {string} [options.clientCn="ait-kit-verify-client"] CN baked into
 *   the generated client certificate; callers assert the server saw it.
 * @returns {Promise<{
 *   baseUrl: string,
 *   dir: string,
 *   caPath: string, certPath: string, keyPath: string,
 *   ca: string,
 *   close: () => Promise<void>
 * }>}
 */
export async function startMtlsServer({ clientCn = "ait-kit-verify-client" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ait-kit-mtls-verify-"));
  let child;
  try {
    const run = (args) => execFileSync("openssl", args, { cwd: dir });
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=ait-kit-verify-ca"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost"]);
    execFileSync(
      "openssl",
      ["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "1", "-extfile", "-"],
      { cwd: dir, input: "subjectAltName=DNS:localhost,IP:127.0.0.1\n" }
    );
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", `/CN=${clientCn}`]);
    run(["x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.crt", "-days", "1"]);

    child = spawn(
      "node",
      [join(rootDir, "packages/api-client/test/helpers/mtls-test-server.mjs"), dir, "0"],
      { stdio: ["ignore", "pipe", "inherit"] }
    );
    // Startup-failure cleanup must kill the orphaned child and remove the
    // generated key material; once readiness settles it must not fire again.
    let settled = false;
    const port = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        rmSync(dir, { recursive: true, force: true });
        reject(new Error("mTLS verification server did not start"));
      }, 10_000);
      child.stdout.on("data", (chunk) => {
        const match = /ready:(\d+)/.exec(chunk.toString());
        if (match) {
          clearTimeout(timeout);
          resolve(Number(match[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (!settled) {
          rmSync(dir, { recursive: true, force: true });
          reject(new Error(`mTLS verification server exited early: ${code}`));
        }
      });
    }).finally(() => {
      settled = true;
    });
    return {
      baseUrl: `https://localhost:${port}`,
      dir,
      caPath: join(dir, "ca.crt"),
      certPath: join(dir, "client.crt"),
      keyPath: join(dir, "client.key"),
      ca: readFileSync(join(dir, "ca.crt"), "utf8"),
      close: async () => {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          const forceKill = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 2_000);
          child.on("exit", () => {
            clearTimeout(forceKill);
            resolve();
          });
        });
        rmSync(dir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    // Material generation or startup failed: no orphaned helper process and
    // no leftover key material may survive the failure.
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Absolute file:// URL for a repository file, for generated thin consumers
 * that must import repository test helpers (e.g. the shared mTLS contract
 * scenarios) while resolving the package under test from their own
 * node_modules.
 */
export function repoFileUrl(relativePath) {
  return pathToFileURL(join(rootDir, relativePath)).href;
}
