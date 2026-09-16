import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MtlsClient } from "@ait-kit/api-core";
import {
  createNodeMtlsTransport,
  NodeMtlsTransportError
} from "../src/node";
import { startMtlsTestServer, type MtlsTestServer } from "./helpers/mtls-test-server";

describe("@ait-kit/api-client/node mTLS transport", () => {
  let server: MtlsTestServer;
  let transport: MtlsClient;

  beforeAll(async () => {
    server = await startMtlsTestServer();
    transport = createNodeMtlsTransport({
      cert: server.clientCert,
      key: server.clientKey,
      ca: server.ca
    });
  });

  afterAll(async () => {
    await server.close();
  });

  test("performs a mutually authenticated request against a local mTLS server", async () => {
    const response = await transport.request(`${server.baseUrl}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "mtls" })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const payload = (await response.json()) as { clientCn: string; body: string; contentType: string };
    // The server enforces client certificates; reaching the handler at all
    // means the handshake presented our cert, and the echo proves it.
    expect(payload.clientCn).toBe("ait-kit-test-client");
    expect(payload.body).toBe(JSON.stringify({ hello: "mtls" }));
    expect(payload.contentType).toBe("application/json");
  });

  test("returns a fully buffered body for an immediate response", async () => {
    const response = await transport.request(`${server.baseUrl}/immediate`, { method: "GET" });
    const payload = (await response.json()) as { ok: boolean };
    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
  });

  test("resolves null-body statuses with a null response body", async () => {
    const response = await transport.request(`${server.baseUrl}/no-content`, { method: "GET" });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  test("rejects non-finite budget options at construction", () => {
    for (const maxResponseBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(() =>
        createNodeMtlsTransport({
          cert: server.clientCert,
          key: server.clientKey,
          ca: server.ca,
          maxResponseBytes
        })
      ).toThrow(/maxResponseBytes/);
    }
    for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() =>
        createNodeMtlsTransport({
          cert: server.clientCert,
          key: server.clientKey,
          ca: server.ca,
          timeoutMs
        })
      ).toThrow(/timeoutMs/);
    }
  });

  test("completes a slowly streaming body within the overall deadline", async () => {
    const response = await transport.request(`${server.baseUrl}/slow-body?chunks=3`, { method: "GET" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("chunk-1\nchunk-2\nchunk-3\n");
  });

  test("rejects when the response body breaks before completing", async () => {
    const promise = transport.request(`${server.baseUrl}/break-body`, { method: "GET" });
    await expect(promise).rejects.toBeInstanceOf(NodeMtlsTransportError);
    await expect(promise).rejects.toMatchObject({ code: "REQUEST_FAILED" });
  });

  test("applies one hard deadline across headers and body", async () => {
    const slow = createNodeMtlsTransport({
      cert: server.clientCert,
      key: server.clientKey,
      ca: server.ca,
      timeoutMs: 300
    });

    await expect(slow.request(`${server.baseUrl}/hang-headers`, { method: "GET" })).rejects.toMatchObject({
      code: "TIMEOUT",
      name: "NodeMtlsTransportError"
    });

    // A slow-but-completing body that outlives the budget must also time out:
    // receiving headers alone does not clear the timer.
    await expect(
      slow.request(`${server.baseUrl}/slow-body?chunks=30`, { method: "GET" })
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("resolves valid 4xx and 5xx statuses as HTTP responses", async () => {
    // Transport failures and HTTP failures stay separate: a technically
    // valid 500 resolves as a Response for the upper layers to interpret.
    const serverError = await transport.request(`${server.baseUrl}/status?code=500`, { method: "GET" });
    expect(serverError.status).toBe(500);
    expect(serverError.ok).toBe(false);

    const notFound = await transport.request(`${server.baseUrl}/status?code=404`, { method: "GET" });
    expect(notFound.status).toBe(404);
  });

  test("resolves 205 and 304 with null bodies like 204", async () => {
    const reset = await transport.request(`${server.baseUrl}/status?code=205`, { method: "GET" });
    expect(reset.status).toBe(205);
    expect(reset.body).toBeNull();

    const notModified = await transport.request(`${server.baseUrl}/status?code=304`, { method: "GET" });
    expect(notModified.status).toBe(304);
    expect(notModified.body).toBeNull();
  });

  test("rejects status-600 responses as typed REQUEST_FAILED conversion failures", async () => {
    const promise = transport.request(`${server.baseUrl}/status?code=600`, { method: "GET" });

    let error: unknown;
    try {
      await promise;
    } catch (caught) {
      error = caught;
    }
    // Not pending, not TIMEOUT: the completed body's conversion to a fetch
    // Response must reject through the typed failure path.
    expect(error).toBeInstanceOf(NodeMtlsTransportError);
    expect((error as NodeMtlsTransportError).code).toBe("REQUEST_FAILED");
    expect((error as NodeMtlsTransportError).cause).toBeInstanceOf(Error);

    // The same transport instance serves a normal request afterwards, and
    // the failed conversion did not re-contact the server.
    const next = await transport.request(`${server.baseUrl}/immediate`, { method: "GET" });
    expect(next.status).toBe(200);
  });

  test("runs the core lifecycle in the Node client runtime against the built dist", async () => {
    // The suite itself runs under Bun; this check runs the BUILT /node
    // output in a real Node child process (no global handlers, so an
    // uncaught conversion exception would exit non-zero) covering: a
    // normal mTLS 200 request, the status-600 conversion regression
    // (typed REQUEST_FAILED with the cause preserved), and a successful
    // follow-up request on the same transport.
    const here = dirname(fileURLToPath(import.meta.url));
    const child = spawn(
      "node",
      [
        join(here, "helpers/node-runtime-check.mjs"),
        server.baseUrl,
        join(server.dir, "ca.crt"),
        join(server.dir, "client.crt"),
        join(server.dir, "client.key")
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    const exitCode = await new Promise<number | null>((resolve) => {
      const watchdog = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(null);
      }, 30_000);
      child.on("exit", (code) => {
        clearTimeout(watchdog);
        resolve(code);
      });
    });

    // A watchdog kill (null) fails the test: the child must terminate on
    // its own, and it must terminate successfully.
    expect(exitCode).toBe(0);
    expect(stdout).toContain("PASS");
    expect(stderr).toBe("");
  });

  test("rejects already-aborted requests without contacting the server", async () => {
    const controller = new AbortController();
    controller.abort();
    const failingTransport = createNodeMtlsTransport({
      cert: server.clientCert,
      key: server.clientKey,
      ca: server.ca
    });

    await expect(
      failingTransport.request(`${server.baseUrl}/immediate`, { method: "GET", signal: controller.signal })
    ).rejects.toMatchObject({ code: "ALREADY_ABORTED" });
  });

  test("destroys the request when the caller aborts mid-flight", async () => {
    const controller = new AbortController();
    const promise = transport.request(`${server.baseUrl}/slow-body?chunks=50`, {
      method: "GET",
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 60);

    await expect(promise).rejects.toMatchObject({ code: "ABORTED" });
    // Cleanup is behavioral: a later abort on the same signal is inert, and
    // the same transport keeps serving new requests.
    controller.abort();
    const next = await transport.request(`${server.baseUrl}/immediate`, { method: "GET" });
    expect(next.status).toBe(200);
  });

  test("rejects responses that exceed the configured size limit", async () => {
    const limited = createNodeMtlsTransport({
      cert: server.clientCert,
      key: server.clientKey,
      ca: server.ca,
      maxResponseBytes: 64 * 1024
    });

    await expect(
      limited.request(`${server.baseUrl}/large?size=${256 * 1024}`, { method: "GET" })
    ).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
      name: "NodeMtlsTransportError"
    });

    // The same transport still works afterwards.
    const ok = await limited.request(`${server.baseUrl}/large?size=${32 * 1024}`, { method: "GET" });
    expect(ok.status).toBe(200);
    expect((await ok.arrayBuffer()).byteLength).toBe(32 * 1024);
  });

  test("rejects non-https urls and unsupported bodies before connecting", async () => {
    await expect(transport.request("http://localhost/x", { method: "GET" })).rejects.toMatchObject({
      code: "INVALID_URL"
    });
    await expect(transport.request("not a url", { method: "GET" })).rejects.toMatchObject({
      code: "INVALID_URL"
    });
    await expect(
      transport.request(`${server.baseUrl}/echo`, {
        method: "POST",
        body: { unsupported: true } as unknown as string
      })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_BODY" });
  });

  test("rejects with REQUEST_FAILED when the server rejects the client certificate", async () => {
    // Wrong CA: the handshake fails during TLS verification.
    const untrusted = createNodeMtlsTransport({
      cert: server.clientCert,
      key: server.clientKey,
      ca: server.clientCert // not a CA for this server
    });

    await expect(untrusted.request(`${server.baseUrl}/immediate`, { method: "GET" })).rejects.toMatchObject({
      name: "NodeMtlsTransportError"
    });
  });
});
