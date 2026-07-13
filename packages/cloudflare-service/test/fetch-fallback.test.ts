import { describe, expect, test } from "bun:test";
import type { AppsInTossApiRpc, HealthResponse } from "@ait-kit/api-core";
import { handleFetchFallback } from "../src/fetch-fallback";

describe("Cloudflare HTTP fallback", () => {
  test("keeps health available without bearer authentication", async () => {
    const response = await handleFetchFallback(
      new Request("https://service.example/internal/apps-in-toss/health"),
      fakeRpc()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, ready: true });
  });

  test("returns service unavailable when health is not ready", async () => {
    const response = await handleFetchFallback(
      new Request("https://service.example/internal/apps-in-toss/health"),
      fakeRpc({
        ok: false,
        ready: false,
        mode: "forward",
        scope: "apps-in-toss-api",
        error: "MISSING_MTLS_CLIENT",
        checks: { mtlsClient: false, rawMtlsEnabled: false }
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ ok: false, ready: false });
  });

  test("keeps POST routes disabled when no bearer token is configured", async () => {
    const response = await promotionRequest();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "NOT_FOUND" });
  });

  test("rejects an invalid bearer token", async () => {
    const response = await promotionRequest("wrong-token", "expected-token");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toEqual({ ok: false, error: "UNAUTHORIZED" });
  });

  test("dispatches an authenticated POST route", async () => {
    const response = await promotionRequest("expected-token", "expected-token");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, providerStatus: "GRANTED" });
  });
});

function promotionRequest(providedToken?: string, expectedToken?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (providedToken) headers.set("authorization", `Bearer ${providedToken}`);
  return handleFetchFallback(
    new Request("https://service.example/internal/apps-in-toss/promotion/reward/grant", {
      method: "POST",
      headers,
      body: "{}"
    }),
    fakeRpc(),
    { bearerToken: expectedToken }
  );
}

function fakeRpc(
  health: HealthResponse = {
    ok: true,
    ready: true,
    mode: "stub",
    scope: "apps-in-toss-api",
    checks: { mtlsClient: false, rawMtlsEnabled: false }
  }
): AppsInTossApiRpc {
  return {
    async health() {
      return health;
    },
    async rawMtlsRequest() {
      return { ok: true, status: 200, headers: {}, body: {} };
    },
    async genericMtlsRequest() {
      return { ok: true, status: 200, headers: {}, body: {} };
    },
    async tossLoginComplete() {
      return { ok: true, userKey: "user", referrer: "DEFAULT", scopes: [], agreedTerms: [] };
    },
    async tossLoginRemoveByUserKey() {
      return { ok: true, providerStatus: "REMOVED" };
    },
    async iapOrderStatus() {
      return { ok: true, providerStatus: "PURCHASED" };
    },
    async promotionRewardGrant() {
      return { ok: true, providerStatus: "GRANTED" };
    },
    async smartMessageSend() {
      return { ok: true, providerStatus: "SENT" };
    },
    async smartMessageBulkSend() {
      return { ok: true, providerStatus: "SENT" };
    }
  };
}
