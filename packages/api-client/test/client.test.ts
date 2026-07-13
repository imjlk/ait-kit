import { describe, expect, test } from "bun:test";
import {
  PROXY_ENDPOINTS,
  TossMtlsHttpClientError,
  TossMtlsHttpClientTimeoutError,
  createTossMtlsHttpClient
} from "../src";

describe("@ait-kit/api-client", () => {
  test("calls health without a request body", async () => {
    const calls: FetchCall[] = [];
    const client = createTossMtlsHttpClient({
      baseUrl: "http://proxy.local/",
      token: "secret",
      fetch: fakeFetch(calls, {
        ok: true,
        ready: true,
        mode: "stub",
        scope: "apps-in-toss-api",
        checks: { mtlsClient: false, rawMtlsEnabled: false }
      })
    });

    const result = await client.health();

    expect(result).toEqual({
      ok: true,
      ready: true,
      mode: "stub",
      scope: "apps-in-toss-api",
      checks: { mtlsClient: false, rawMtlsEnabled: false }
    });
    expect(calls).toEqual([
      {
        url: `http://proxy.local${PROXY_ENDPOINTS.health}`,
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer secret"
        },
        body: undefined
      }
    ]);
  });

  test("returns an unhealthy health payload from a 503 response", async () => {
    const health = {
      ok: false as const,
      ready: false as const,
      mode: "forward" as const,
      scope: "apps-in-toss-api" as const,
      error: "MISSING_MTLS_CLIENT",
      checks: { mtlsClient: false, rawMtlsEnabled: false }
    };
    const client = createTossMtlsHttpClient({
      baseUrl: "http://proxy.local",
      fetch: async () => Response.json(health, { status: 503 })
    });

    await expect(client.health()).resolves.toEqual(health);
  });

  test("posts adapter requests with bearer auth and JSON bodies", async () => {
    const calls: FetchCall[] = [];
    const client = createTossMtlsHttpClient({
      baseUrl: "http://proxy.local",
      token: "secret",
      fetch: fakeFetch(calls, { ok: true, providerStatus: "SENT" })
    });

    const result = await client.smartMessageSend({ templateSetCode: "template", context: {} });

    expect(result).toEqual({ ok: true, providerStatus: "SENT" });
    expect(calls).toEqual([
      {
        url: `http://proxy.local${PROXY_ENDPOINTS.smartMessageSend}`,
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer secret",
          "content-type": "application/json"
        },
        body: JSON.stringify({ templateSetCode: "template", context: {} })
      }
    ]);
  });

  test("maps each public method to the proxy endpoints", async () => {
    const calls: FetchCall[] = [];
    const client = createTossMtlsHttpClient({
      baseUrl: "http://proxy.local",
      fetch: fakeFetch(calls, { ok: true })
    });

    await client.genericMtlsRequest({ path: "/anything" });
    await client.tossLoginComplete({});
    await client.tossLoginRemoveByUserKey({});
    await client.iapOrderStatus({});
    await client.promotionRewardGrant({});
    await client.smartMessageBulkSend({ templateSetCode: "template", contextList: [] });

    expect(calls.map((call) => call.url.replace("http://proxy.local", ""))).toEqual([
      PROXY_ENDPOINTS.genericMtlsRequest,
      PROXY_ENDPOINTS.tossLoginComplete,
      PROXY_ENDPOINTS.tossLoginRemoveByUserKey,
      PROXY_ENDPOINTS.iapOrderStatus,
      PROXY_ENDPOINTS.promotionRewardGrant,
      PROXY_ENDPOINTS.smartMessageBulkSend
    ]);
    expect(PROXY_ENDPOINTS.genericMtlRequest).toBe(PROXY_ENDPOINTS.genericMtlsRequest);
  });

  test("throws on non-2xx proxy responses with parsed status and body", async () => {
    const client = createTossMtlsHttpClient({
      baseUrl: "http://proxy.local",
      fetch: async () =>
        new Response("", {
          status: 502,
          headers: { "content-type": "text/plain" }
        })
    });

    await expect(client.health()).rejects.toMatchObject({
      name: "TossMtlsHttpClientError",
      status: 502,
      body: {}
    });
    await expect(client.health()).rejects.toBeInstanceOf(TossMtlsHttpClientError);
  });

  test("aborts proxy calls that exceed timeoutMs", async () => {
    let signal: AbortSignal | undefined;
    const client = createTossMtlsHttpClient({
      baseUrl: "http://proxy.local",
      timeoutMs: 1,
      fetch: async (_url, init = {}) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init.signal ?? undefined;
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true
          });
        })
    });

    await expect(client.health()).rejects.toMatchObject({
      name: "TossMtlsHttpClientTimeoutError",
      timeoutMs: 1
    });
    await expect(client.health()).rejects.toBeInstanceOf(TossMtlsHttpClientTimeoutError);
    expect(signal?.aborted).toBe(true);
  });
});

interface FetchCall {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
}

function fakeFetch(calls: FetchCall[], body: unknown) {
  return async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: init.headers,
      body: init.body
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}
