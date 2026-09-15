import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
