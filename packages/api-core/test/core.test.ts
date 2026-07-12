import { describe, expect, test } from "bun:test";
import { createAppsInTossApiRpc, createAppsInTossApi, TOSS_ENDPOINTS, type MtlsClient } from "../src";

describe("@ait-kit/api-core", () => {
  test("returns deterministic stub login users without a transport", async () => {
    const api = createAppsInTossApiRpc(createAppsInTossApi({ mode: "stub" }));

    const first = await api.tossLoginComplete({ authorizationCode: "dev-code", referrer: "SANDBOX" });
    const second = await api.tossLoginComplete({ authorizationCode: "dev-code", referrer: "SANDBOX" });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, referrer: "SANDBOX", scopes: ["user_key"] });
  });

  test("reports missing forward mTLS transport in health", async () => {
    const api = createAppsInTossApiRpc(createAppsInTossApi({ mode: "forward" }));

    await expect(api.health()).resolves.toEqual({
      ok: false,
      ready: false,
      mode: "forward",
      scope: "apps-in-toss-api",
      error: "MISSING_MTLS_CLIENT",
      checks: { mtlsClient: false, rawMtlsEnabled: false }
    });
  });

  test("reports a missing app id for factory-backed forward health", async () => {
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        mtlsClientFactory: {
          async forApp() {
            throw new Error("health must not resolve the factory");
          }
        }
      })
    );

    await expect(api.health()).resolves.toEqual({
      ok: false,
      ready: false,
      mode: "forward",
      scope: "apps-in-toss-api",
      error: "MISSING_MTLS_APP_ID",
      checks: { mtlsClient: false, rawMtlsEnabled: false }
    });
  });

  test("disables generic raw mTLS relay by default", async () => {
    const mtlsClient: MtlsClient = {
      async request() {
        return Response.json({ ok: true });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    await expect(api.genericMtlsRequest({ path: "/anything" })).rejects.toMatchObject({
      code: "RAW_MTLS_DISABLED",
      status: 403
    });
  });

  test("builds absolute Toss URLs for forward login flow", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mtlsClient: MtlsClient = {
      async request(url, init) {
        calls.push({ url, init });
        if (url.endsWith(TOSS_ENDPOINTS.loginGenerateToken)) {
          return Response.json({ success: { accessToken: "access-token", expiresIn: "3600" } });
        }
        return Response.json({ success: { userKey: "user-key", scope: "user_key profile" } });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    const response = await api.tossLoginComplete({ authorizationCode: "code", referrer: "SANDBOX" });

    expect(response).toMatchObject({ ok: true, userKey: "user-key", scopes: ["user_key", "profile"] });
    expect(response.ok && response.expiresIn).toBe(3600);
    expect(calls.map((call) => call.url)).toEqual([
      "https://partner.example/api-partner/v1/apps-in-toss/user/oauth2/generate-token",
      "https://partner.example/api-partner/v1/apps-in-toss/user/oauth2/login-me"
    ]);
    expect(calls[1]?.init.headers).toMatchObject({ authorization: "Bearer access-token" });
  });

  test("treats top-level Toss unlink error codes as failures", async () => {
    const mtlsClient: MtlsClient = {
      async request() {
        return Response.json({ errorCode: "USER_KEY_NOT_FOUND", message: "missing user key" });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    const response = await api.tossLoginRemoveByUserKey({
      userKey: "sensitive-toss-user-key",
      accessToken: "expired-access-token"
    });

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "FAILED",
      failureReason: "missing user key",
      providerErrorCode: "USER_KEY_NOT_FOUND",
      upstreamStatus: 200
    });
    expect(JSON.stringify(response)).not.toContain("sensitive-toss-user-key");
    expect(JSON.stringify(response)).not.toContain("expired-access-token");
  });

  test("falls back to now when promotion requestedAt is null at runtime", async () => {
    const api = createAppsInTossApiRpc(createAppsInTossApi({ mode: "stub", now: () => 123_456 }));

    const response = await api.promotionRewardGrant({ requestedAt: null as unknown as number });

    expect(response).toMatchObject({
      ok: true,
      providerStatus: "GRANTED",
      grantedAt: 123_456
    });
  });

  test.each([
    ["SUCCESS", "GRANTED", true],
    ["PENDING", "PENDING", true],
    ["FAILED", "FAILED", false]
  ] as const)("normalizes promotion success status %s", async (success, providerStatus, ok) => {
    const seenBodies: unknown[] = [];
    const mtlsClient: MtlsClient = {
      async request(url, init) {
        seenBodies.push(JSON.parse(String(init.body)));
        if (url.endsWith(TOSS_ENDPOINTS.promotionGetKey)) {
          return Response.json({ resultType: "SUCCESS", success: { key: "promotion-key" } });
        }
        if (url.endsWith(TOSS_ENDPOINTS.promotionExecute)) {
          return Response.json({ resultType: "SUCCESS", success: "SUCCESS" });
        }
        return Response.json({ resultType: "SUCCESS", success });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    const response = await api.promotionRewardGrant({
      tossUserKey: "user-key",
      promotionCode: "promotion-code",
      amount: 1_000
    });

    expect(response).toMatchObject({ ok, providerStatus, providerTransactionKey: "promotion-key" });
    expect(seenBodies[1]).toEqual({ promotionCode: "promotion-code", key: "promotion-key", amount: 1_000 });
  });

  test("rejects a missing promotion amount before calling Toss", async () => {
    let called = false;
    const mtlsClient: MtlsClient = {
      async request() {
        called = true;
        return Response.json({});
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    const response = await api.promotionRewardGrant({
      tossUserKey: "user-key",
      promotionCode: "promotion-code"
    });

    expect(response).toMatchObject({ ok: false, providerStatus: "MISSING_TOSS_PROMOTION_AMOUNT" });
    expect(called).toBe(false);
  });

  test("rejects a non-success promotion key response", async () => {
    const mtlsClient: MtlsClient = {
      async request() {
        return Response.json({ message: "promotion service unavailable" }, { status: 503 });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    const response = await api.promotionRewardGrant({
      tossUserKey: "user-key",
      promotionCode: "promotion-code",
      amount: 1_000
    });

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "PROMOTION_KEY_FAILED",
      failureReason: "promotion service unavailable"
    });
  });

  test("normalizes smart message bulk requests", async () => {
    const seenBodies: unknown[] = [];
    const mtlsClient: MtlsClient = {
      async request(_url, init) {
        seenBodies.push(JSON.parse(String(init.body)));
        return Response.json({ success: { result: { msgCount: 2 } } });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    const response = await api.smartMessageBulkSend({
      templateCode: "template",
      contextList: [
        { tossUserKey: "u1", context: { name: "A" } },
        { userKey: "u2", context: { name: "B" } }
      ]
    });

    expect(response).toMatchObject({ ok: true, providerStatus: "SENT", msgCount: 2 });
    expect(seenBodies[0]).toEqual({
      templateSetCode: "template",
      contextList: [
        { userKey: "u1", context: { name: "A" } },
        { userKey: "u2", context: { name: "B" } }
      ]
    });
  });

  test("genericMtlsRequest aliases rawMtlsRequest", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mtlsClient: MtlsClient = {
      async request(url, init) {
        calls.push({ url, init });
        return Response.json({ ok: true }, { status: 201, headers: { "x-result": "ok" } });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient,
        allowRawMtls: true
      })
    );

    const request = { method: "POST", path: "/anything", body: { value: 1 } };
    const raw = await api.rawMtlsRequest(request);
    const generic = await api.genericMtlsRequest(request);

    expect(raw).toEqual(generic);
    expect(raw).toMatchObject({
      ok: true,
      status: 201,
      headers: { "x-result": "ok" },
      body: { ok: true }
    });
    expect(raw.headers["content-type"]).toStartWith("application/json");
    expect(calls.map((call) => call.url)).toEqual([
      "https://partner.example/anything",
      "https://partner.example/anything"
    ]);
  });
});
