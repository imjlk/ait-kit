import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface MtlsTestServer {
  port: number;
  ca: string;
  clientCert: string;
  clientKey: string;
  baseUrl: string;
  /** Directory holding the generated PEM files (ca.crt, client.crt, client.key). */
  dir: string;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Boots a local HTTPS server that enforces client certificates (real mTLS)
 * using OpenSSL-generated materials, ready for transport tests.
 */
export async function startMtlsTestServer(): Promise<MtlsTestServer> {
  const dir = mkdtempSync(join(tmpdir(), "ait-kit-mtls-"));
  const cert = (name: string) => join(dir, name);

  const run = (args: string[]) => execFileSync("openssl", args, { cwd: dir });

  // CA
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "1", "-subj", "/CN=ait-kit-test-ca"]);
  // Server certificate signed by the CA for localhost.
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost"]);
  execFileSync(
    "openssl",
    ["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "1", "-extfile", "-"],
    { cwd: dir, input: "subjectAltName=DNS:localhost,IP:127.0.0.1\n" }
  );
  // Client certificate signed by the same CA.
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", "/CN=ait-kit-test-client"]);
  run(["x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.crt", "-days", "1"]);

  // Run the server under real Node even when the suite executes under Bun:
  // the transport claims Node's TLS stack, so tests must exercise it.
  const child = spawn("node", [join(here, "mtls-test-server.mjs"), dir, "0"], {
    stdio: ["ignore", "pipe", "inherit"]
  });

  const port = await new Promise<number>((resolve, reject) => {
    // Buffer stdout: a `ready:<port>` line may split across data events.
    let stdoutBuffer = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("mTLS test server did not start"));
    }, 10_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const match = /ready:(\d+)/.exec(stdoutBuffer);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    // A failed spawn emits 'error' asynchronously; without a listener it
    // would crash the test process as an uncaught exception.
    child.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`mTLS test server exited early: ${code}`));
    });
  });

  return {
    port,
    ca: readFileSync(cert("ca.crt"), "utf8"),
    clientCert: readFileSync(cert("client.crt"), "utf8"),
    clientKey: readFileSync(cert("client.key"), "utf8"),
    baseUrl: `https://localhost:${port}`,
    dir,
    close: async () => {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.on("exit", () => resolve());
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
      });
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
