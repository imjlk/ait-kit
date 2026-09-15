import { describe, expect, test } from "bun:test";
import {
  createAppsInTossApiRpc,
  createAppsInTossApi,
  normalizeIapOrderStatusResponse,
  normalizeMessageResponse,
  TOSS_ENDPOINTS,
  type MtlsClient,
  type SmartMessageBulkSendInput,
  type SmartMessageSendInput
} from "../src";

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

  test("checks an IAP order without requiring a Toss user key", async () => {
    let seenHeaders = new Headers();
    const mtlsClient: MtlsClient = {
      async request(_url, init) {
        seenHeaders = new Headers(init.headers);
        return Response.json({
          resultType: "SUCCESS",
          success: { orderId: "order-id", status: "PAYMENT_COMPLETED" }
        });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    const response = await api.iapOrderStatus({ orderId: "order-id" });

    expect(response).toMatchObject({
      ok: true,
      verified: true,
      orderId: "order-id",
      providerStatus: "PAYMENT_COMPLETED"
    });
    expect(response).not.toHaveProperty("sku");
    expect(response).not.toHaveProperty("skuCheck");
    expect(seenHeaders.get("x-toss-user-key")).toBeNull();
  });

  test("surfaces a non-success IAP HTTP response", async () => {
    const mtlsClient: MtlsClient = {
      async request() {
        return Response.json({ message: "order service unavailable" }, { status: 503 });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    const response = await api.iapOrderStatus({ orderId: "order-id" });

    expect(response).toMatchObject({
      ok: false,
      orderId: "order-id",
      providerStatus: "ERROR",
      failureReason: "order service unavailable",
      upstreamStatus: 503
    });
  });

  function forwardIapApi(handler: MtlsClient["request"], options: Record<string, unknown> = {}) {
    const mtlsClient: MtlsClient = { request: handler };
    return createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient,
        iapOrderStatusRetryDelayMs: 0,
        ...options
      })
    );
  }

  test("does not backfill the request SKU when the provider omits SKU evidence", async () => {
    const api = forwardIapApi(async () =>
      Response.json({
        resultType: "SUCCESS",
        success: { orderId: "order-id", status: "PAYMENT_COMPLETED" }
      })
    );

    const response = await api.iapOrderStatus({ orderId: "order-id", sku: "expected-sku" });

    expect(response).toMatchObject({
      ok: true,
      verified: true,
      orderId: "order-id",
      providerStatus: "PAYMENT_COMPLETED",
      skuCheck: { status: "NOT_PROVIDED" }
    });
    expect(response).not.toHaveProperty("sku");
    expect(response).not.toHaveProperty("verificationCode");
  });

  test("verifies a payable order with matching provider SKU evidence", async () => {
    const api = forwardIapApi(async () =>
      Response.json({
        resultType: "SUCCESS",
        success: { orderId: "order-id", status: "PURCHASED", sku: "expected-sku" }
      })
    );

    const response = await api.iapOrderStatus({ orderId: "order-id", sku: "expected-sku" });

    expect(response).toMatchObject({
      ok: true,
      verified: true,
      orderId: "order-id",
      sku: "expected-sku",
      skuCheck: { status: "MATCHED", providerSku: "expected-sku" }
    });
  });

  test("reports a provider SKU mismatch without rejecting the paid order", async () => {
    const api = forwardIapApi(async () =>
      Response.json({
        resultType: "SUCCESS",
        success: { orderId: "order-id", status: "PAYMENT_COMPLETED", sku: "other-sku" }
      })
    );

    const response = await api.iapOrderStatus({ orderId: "order-id", sku: "expected-sku" });

    expect(response).toMatchObject({
      ok: true,
      verified: true,
      sku: "other-sku",
      skuCheck: { status: "MISMATCHED", providerSku: "other-sku" }
    });
  });

  test("fails verification when the provider order ID differs from the request", async () => {
    const api = forwardIapApi(async () =>
      Response.json({
        resultType: "SUCCESS",
        success: { orderId: "other-order", status: "PAYMENT_COMPLETED", sku: "expected-sku" }
      })
    );

    const response = await api.iapOrderStatus({ orderId: "order-id", sku: "expected-sku" });

    expect(response).toMatchObject({
      ok: true,
      verified: false,
      orderId: "other-order",
      verificationCode: "ORDER_ID_MISMATCH"
    });
  });

  test.each([
    ["ORDER_IN_PROGRESS", "PAYMENT_INCOMPLETE", false],
    ["FAILED", "PAYMENT_FAILED", false],
    ["REFUNDED", "PAYMENT_REFUNDED", false],
    ["MINIAPP_MISMATCH", "MINIAPP_MISMATCH", false],
    ["ERROR", "PROVIDER_STATUS_ERROR", false],
    ["SOMETHING_WEIRD", "UNKNOWN_STATUS", false]
  ] as const)(
    "maps provider status %s to verification code %s",
    async (status, verificationCode) => {
      const calls: unknown[] = [];
      const api = forwardIapApi(async (_url, init) => {
        calls.push(JSON.parse(String(init.body)));
        return Response.json({ resultType: "SUCCESS", success: { orderId: "order-id", status } });
      }, { iapOrderStatusMaxAttempts: 1 });

      const response = await api.iapOrderStatus({ orderId: "order-id" });

      expect(response).toMatchObject({
        ok: true,
        verified: false,
        orderId: "order-id",
        providerStatus: status,
        verificationCode
      });
      expect(calls).toEqual([{ orderId: "order-id" }]);
    }
  );

  test("keeps the pending re-query flow for incomplete payments", async () => {
    const bodies: unknown[] = [];
    let calls = 0;
    const api = forwardIapApi(async (_url, init) => {
      calls += 1;
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({
        resultType: "SUCCESS",
        success:
          calls === 1
            ? { orderId: "order-id", status: "ORDER_IN_PROGRESS" }
            : { orderId: "order-id", status: "PAYMENT_COMPLETED", sku: "expected-sku" }
      });
    }, { iapOrderStatusMaxAttempts: 3 });

    const response = await api.iapOrderStatus({ orderId: "order-id", sku: "expected-sku" });

    expect(response).toMatchObject({
      ok: true,
      verified: true,
      orderId: "order-id",
      providerStatus: "PAYMENT_COMPLETED",
      skuCheck: { status: "MATCHED" },
      attempts: 2
    });
    expect(bodies).toEqual([{ orderId: "order-id" }, { orderId: "order-id" }]);
  });

  test("reports ORDER_NOT_FOUND after exhausting retries", async () => {
    let calls = 0;
    const api = forwardIapApi(async () => {
      calls += 1;
      return Response.json({ resultType: "SUCCESS", success: { orderId: "order-id", status: "NOT_FOUND" } });
    }, { iapOrderStatusMaxAttempts: 2 });

    const response = await api.iapOrderStatus({ orderId: "order-id" });

    expect(response).toMatchObject({
      ok: true,
      verified: false,
      verificationCode: "ORDER_NOT_FOUND",
      attempts: 2
    });
    expect(calls).toBe(2);
  });

  test.each([
    ["orderId", { status: "PAYMENT_COMPLETED" }],
    ["status", { orderId: "order-id" }]
  ] as const)("treats a success payload missing %s as an invalid response", async (_field, success) => {
    const api = forwardIapApi(async () => Response.json({ resultType: "SUCCESS", success }));

    const response = await api.iapOrderStatus({ orderId: "order-id" });

    expect(response).toMatchObject({
      ok: false,
      error: "INVALID_RESPONSE",
      providerStatus: "ERROR"
    });
  });

  test("validates stub input like forward mode", async () => {
    const api = createAppsInTossApiRpc(createAppsInTossApi({ mode: "stub" }));

    await expect(api.iapOrderStatus({ sku: "expected-sku" })).resolves.toMatchObject({
      ok: false,
      error: "MISSING_ORDER_ID",
      providerStatus: "ERROR"
    });
  });

  test("marks stub order status output as synthetic evidence", async () => {
    const api = createAppsInTossApiRpc(createAppsInTossApi({ mode: "stub" }));

    const response = await api.iapOrderStatus({ orderId: "order-id", sku: "expected-sku" });

    expect(response).toMatchObject({
      ok: true,
      verified: false,
      verificationCode: "STUB_EVIDENCE",
      orderId: "order-id",
      providerStatus: "PAYMENT_COMPLETED",
      sku: "expected-sku",
      skuCheck: { status: "MATCHED", providerSku: "expected-sku" },
      stub: true
    });
  });

  test("requires a requested order ID when normalizing directly", () => {
    const response = normalizeIapOrderStatusResponse(
      {},
      { resultType: "SUCCESS", success: { orderId: "provider-order", status: "PAYMENT_COMPLETED" } }
    );

    expect(response).toMatchObject({
      ok: false,
      error: "MISSING_ORDER_ID",
      orderId: "provider-order"
    });
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

  test("reuses a promotion transaction key without requiring an amount", async () => {
    const seenUrls: string[] = [];
    const mtlsClient: MtlsClient = {
      async request(url) {
        seenUrls.push(url);
        return Response.json({ resultType: "SUCCESS", success: "SUCCESS" });
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
      providerTransactionKey: "existing-key"
    });

    expect(response).toMatchObject({
      ok: true,
      providerStatus: "GRANTED",
      providerTransactionKey: "existing-key"
    });
    expect(seenUrls).toEqual([`https://partner.example${TOSS_ENDPOINTS.promotionResult}`]);
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
    const seenHeaders: Headers[] = [];
    const mtlsClient: MtlsClient = {
      async request(_url, init) {
        seenBodies.push(JSON.parse(String(init.body)));
        seenHeaders.push(new Headers(init.headers));
        return Response.json({ success: { result: { msgCount: 3 } } });
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
        { userKey: 1234, context: { name: "B" } },
        { anonKey: "anonymous", context: { name: "C" } }
      ]
    });

    expect(response).toMatchObject({ ok: true, providerStatus: "SENT", msgCount: 3 });
    expect(seenBodies[0]).toEqual({
      templateSetCode: "template",
      contextList: [
        { userKey: "u1", context: { name: "A" } },
        { userKey: 1234, context: { name: "B" } },
        { anonKey: "anonymous", context: { name: "C" } }
      ]
    });
    // Bulk sends carry recipients in contextList body fields, never in headers.
    expect(seenHeaders[0].get("x-toss-user-key")).toBeNull();
    expect(seenHeaders[0].get("x-anon-key")).toBeNull();
  });

  test.each(
    (
      [
        ["no identifier", {}],
        ["duplicate identifiers", { userKey: "u", anonKey: "a" }],
        ["wrong anon key type", { anonKey: 42 }],
        ["empty user key", { userKey: "" }]
      ] as ReadonlyArray<readonly [string, Record<string, unknown>]>
    ).flatMap(([label, recipient]) => [
      ["forward", label, recipient],
      ["stub", label, recipient]
    ] as const)
  )("rejects a bulk recipient with %s (%s)", async (mode, _label, recipient) => {
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode,
        upstreamBaseUrl: "https://partner.example",
        mtlsClient: {
          async request() {
            throw new Error("invalid recipients must not reach the transport");
          }
        }
      })
    );

    const input = {
      templateSetCode: "template",
      contextList: [{ ...recipient, context: {} }]
    } as unknown as SmartMessageBulkSendInput;
    await expect(api.smartMessageBulkSend(input)).rejects.toMatchObject({
      code: "INVALID_CONTEXT_RECIPIENT",
      status: 400
    });
  });

  test("uses the smart message user header and returns all channel counts", async () => {
    let seenHeaders = new Headers();
    let seenBody: unknown;
    const mtlsClient: MtlsClient = {
      async request(_url, init) {
        seenHeaders = new Headers(init.headers);
        seenBody = JSON.parse(String(init.body));
        return Response.json({
          resultType: "SUCCESS",
          success: {
            msgCount: 3,
            sentPushCount: 0,
            sentInboxCount: 0,
            sentSmsCount: 1,
            sentAlimtalkCount: 1,
            sentFriendtalkCount: 1
          }
        });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    const response = await api.smartMessageSend({
      userKey: "user-key",
      templateSetCode: "template",
      context: { name: "A" }
    });

    expect(response).toMatchObject({
      ok: true,
      providerStatus: "SENT",
      msgCount: 3,
      sentSmsCount: 1,
      sentAlimtalkCount: 1,
      sentFriendtalkCount: 1
    });
    expect(seenHeaders.get("x-toss-user-key")).toBe("user-key");
    expect(seenHeaders.get("x-user-key")).toBeNull();
    expect(seenBody).toEqual({ templateSetCode: "template", context: { name: "A" } });
  });

  test.each([
    ["tossUserKey", { tossUserKey: "toss-user-key" }, "toss-user-key"],
    ["userKey", { userKey: "legacy-user-key" }, "legacy-user-key"]
  ] as const)(
    "sends legacy %s recipients through the x-toss-user-key header",
    async (_label, recipient, expectedHeader) => {
      let seenHeaders = new Headers();
      const mtlsClient: MtlsClient = {
        async request(_url, init) {
          seenHeaders = new Headers(init.headers);
          return Response.json({ resultType: "SUCCESS", success: { msgCount: 1 } });
        }
      };
      const api = createAppsInTossApiRpc(
        createAppsInTossApi({
          mode: "forward",
          upstreamBaseUrl: "https://partner.example",
          mtlsClient
        })
      );

      await api.smartMessageSend({
        ...recipient,
        templateSetCode: "template",
        context: {}
      });

      expect(seenHeaders.get("x-toss-user-key")).toBe(expectedHeader);
      expect(seenHeaders.get("x-user-key")).toBeNull();
    }
  );

  test("passes anonymous keys to the x-anon-key header byte-for-byte", async () => {
    let seenHeaders = new Headers();
    const mtlsClient: MtlsClient = {
      async request(_url, init) {
        seenHeaders = new Headers(init.headers);
        return Response.json({ resultType: "SUCCESS", success: { msgCount: 1 } });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    // Callers that store prefixed identifiers must pass the raw SDK hash;
    // the kit never adds or strips prefixes in transit.
    await api.smartMessageSend({
      anonKey: "anon:stored-hash-value",
      templateSetCode: "template",
      context: {}
    });

    expect(seenHeaders.get("x-anon-key")).toBe("anon:stored-hash-value");
    expect(seenHeaders.get("x-toss-user-key")).toBeNull();
  });

  const INVALID_SINGLE_RECIPIENTS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["no identifier", {}],
    ["duplicate identifiers", { userKey: "u", tossUserKey: "t" }],
    ["user and anonymous identifiers", { userKey: "u", anonKey: "a" }],
    ["wrong user key type", { userKey: true }],
    ["empty user key", { userKey: "  " }],
    ["wrong anon key type", { anonKey: 42 }],
    ["empty anon key", { anonKey: "" }]
  ];

  test.each(INVALID_SINGLE_RECIPIENTS.flatMap(([label, recipient]) => [
    ["forward", label, recipient],
    ["stub", label, recipient]
  ] as const))(
    "rejects a single message recipient with %s (%s)",
    async (mode, _label, recipient) => {
      const api = createAppsInTossApiRpc(
        createAppsInTossApi({
          mode,
          upstreamBaseUrl: "https://partner.example",
          mtlsClient: {
            async request() {
              throw new Error("invalid recipients must not reach the transport");
            }
          }
        })
      );

      const input = {
        ...recipient,
        templateSetCode: "template",
        context: {}
      } as unknown as SmartMessageSendInput;
      await expect(api.smartMessageSend(input)).rejects.toMatchObject({
        code: "INVALID_MESSAGE_RECIPIENT",
        status: 400
      });
    }
  );

  test("normalizes the documented smart message failure reason", async () => {
    let seenHeaders = new Headers();
    const mtlsClient: MtlsClient = {
      async request(_url, init) {
        seenHeaders = new Headers(init.headers);
        return Response.json({
          resultType: "SUCCESS",
          success: {
            msgCount: 0,
            sentPushCount: 0,
            sentInboxCount: 0,
            sentSmsCount: 0,
            sentAlimtalkCount: 0,
            sentFriendtalkCount: 0,
            fail: {
              sentSms: [{ contentId: "message-id", reachedFailReason: "recipient unavailable" }]
            }
          }
        });
      }
    };
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient
      })
    );

    const response = await api.smartMessageSend({
      anonKey: "anonymous-user",
      templateSetCode: "template",
      context: { name: "A" }
    });

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "FAILED",
      failureReason: "recipient unavailable",
      failures: [
        { channel: "sentSms", contentId: "message-id", reachedFailReason: "recipient unavailable" }
      ]
    });
    expect(seenHeaders.get("x-anon-key")).toBe("anonymous-user");
  });

  test("uses channel counts when the total message count is zero", () => {
    const response = normalizeMessageResponse(
      {},
      {
        resultType: "SUCCESS",
        success: {
          msgCount: 0,
          sentSmsCount: 1,
          fail: { sentInbox: [{ reachedFailReason: "inbox unavailable" }] }
        }
      }
    );

    expect(response).toMatchObject({
      ok: true,
      providerStatus: "SENT",
      msgCount: 0,
      sentSmsCount: 1
    });
  });

  test("rejects malformed smart message recipient identifiers", async () => {
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient: {
          async request() {
            throw new Error("invalid recipients must not reach the transport");
          }
        }
      })
    );

    await expect(
      api.smartMessageSend({
        userKey: true as unknown as string,
        templateSetCode: "template",
        context: {}
      })
    ).rejects.toMatchObject({ code: "INVALID_MESSAGE_RECIPIENT", status: 400 });
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

  function forwardApi(handler: MtlsClient["request"], options: Record<string, unknown> = {}) {
    const mtlsClient: MtlsClient = { request: handler };
    return createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient,
        ...options
      })
    );
  }

  test("verifies a valid anonymous key with the x-anon-key header", async () => {
    const calls: Array<{ headers: Headers; init: RequestInit }> = [];
    const api = forwardApi(async (_url, init) => {
      calls.push({ headers: new Headers(init.headers), init });
      return Response.json({ resultType: "SUCCESS", success: true });
    });

    const response = await api.verifyAnonKey({ anonKey: "anon:stored-hash-value" });

    expect(response).toEqual({ ok: true, valid: true });
    expect(calls[0].headers.get("x-anon-key")).toBe("anon:stored-hash-value");
    expect(calls[0].init.body).toBeUndefined();
  });

  test("returns a definitive invalid verdict for rejected anonymous keys", async () => {
    const api = forwardApi(async () =>
      Response.json({ resultType: "SUCCESS", success: false })
    );

    const response = await api.verifyAnonKey({ anonKey: "revoked-hash" });

    expect(response).toEqual({ ok: true, valid: false });
  });

  test("distinguishes a missing auth context from an invalid key", async () => {
    const api = forwardApi(async () =>
      Response.json({
        resultType: "FAIL",
        error: { errorCode: "4010", reason: "인증 정보를 찾을 수 없어요." }
      })
    );

    const response = await api.verifyAnonKey({ anonKey: "unknown-hash" });

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "ERROR",
      providerErrorCode: "4010"
    });
    expect(response).not.toHaveProperty("valid");
  });

  test("reports verification service failures without an invalid verdict", async () => {
    const api = forwardApi(async () =>
      Response.json({ message: "verify service unavailable" }, { status: 503 })
    );

    const response = await api.verifyAnonKey({ anonKey: "any-hash" });

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "ERROR",
      upstreamStatus: 503
    });
    expect(response).not.toHaveProperty("valid");
  });

  test("treats a 200 timeout envelope as unverifiable", async () => {
    const api = forwardApi(async () =>
      Response.json({
        resultType: "HTTP_TIMEOUT",
        error: { errorCode: "5000", reason: "upstream timeout" }
      })
    );

    const response = await api.verifyAnonKey({ anonKey: "any-hash" });

    expect(response).toMatchObject({ ok: false, providerErrorCode: "5000" });
    expect(response).not.toHaveProperty("valid");
  });

  test("treats a malformed verdict as unverifiable", async () => {
    const api = forwardApi(async () =>
      Response.json({ resultType: "SUCCESS", success: "yes" })
    );

    const response = await api.verifyAnonKey({ anonKey: "any-hash" });

    expect(response).toMatchObject({
      ok: false,
      error: "INVALID_RESPONSE",
      providerStatus: "ERROR"
    });
    expect(response).not.toHaveProperty("valid");
  });

  test("rejects a bare boolean without a SUCCESS envelope", async () => {
    const api = forwardApi(async () => Response.json({ success: false }));

    const response = await api.verifyAnonKey({ anonKey: "any-hash" });

    expect(response).toMatchObject({
      ok: false,
      error: "INVALID_RESPONSE",
      failureReason: "verify response was not a SUCCESS envelope"
    });
    expect(response).not.toHaveProperty("valid");
  });

  test("converts transport rejections into no-verdict failures", async () => {
    const api = forwardApi(async () => {
      throw new Error("connection reset");
    });

    const response = await api.verifyAnonKey({ anonKey: "any-hash" });

    expect(response).toMatchObject({
      ok: false,
      error: "UPSTREAM_UNAVAILABLE",
      providerStatus: "ERROR",
      failureReason: "anonymous key verification request failed: connection reset"
    });
    expect(response).not.toHaveProperty("valid");
  });

  test.each([
    ["a malformed anon key next to a valid user key", { userKey: "u", anonKey: 42 }],
    ["an empty toss user key next to a valid user key", { userKey: "u", tossUserKey: "" }],
    ["a malformed user key next to a valid anon key", { userKey: true, anonKey: "a" }]
  ] as const)(
    "rejects %s instead of discarding the malformed identifier",
    async (_label, recipient) => {
      const api = createAppsInTossApiRpc(createAppsInTossApi({ mode: "forward" }));

      const input = {
        ...recipient,
        templateSetCode: "template",
        context: {}
      } as unknown as SmartMessageSendInput;
      await expect(api.smartMessageSend(input)).rejects.toMatchObject({
        code: "INVALID_MESSAGE_RECIPIENT",
        status: 400
      });
    }
  );

  test.each(["forward", "stub"] as const)("requires an anonymous key in %s mode", async (mode) => {
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode,
        upstreamBaseUrl: "https://partner.example",
        mtlsClient: {
          async request() {
            throw new Error("missing keys must not reach the transport");
          }
        }
      })
    );

    await expect(api.verifyAnonKey({})).resolves.toMatchObject({
      ok: false,
      error: "MISSING_ANON_KEY",
      providerStatus: "ERROR"
    });
    await expect(api.verifyAnonKey({ anonKey: "   " })).resolves.toMatchObject({
      ok: false,
      error: "MISSING_ANON_KEY"
    });
  });

  test("marks stub verification output as synthetic", async () => {
    const api = createAppsInTossApiRpc(createAppsInTossApi({ mode: "stub" }));

    await expect(api.verifyAnonKey({ anonKey: "anon-hash" })).resolves.toEqual({
      ok: true,
      valid: true,
      stub: true
    });
  });

  describe("promotion prepare / execute / status", () => {
    function recordingApi(handler: MtlsClient["request"], options: Record<string, unknown> = {}) {
      const paths: string[] = [];
      const headers: Headers[] = [];
      const bodies: unknown[] = [];
      const mtlsClient: MtlsClient = {
        async request(url, init) {
          paths.push(new URL(url).pathname);
          headers.push(new Headers(init.headers));
          bodies.push(init.body === undefined ? undefined : JSON.parse(String(init.body)));
          return handler(url, init);
        }
      };
      return {
        api: createAppsInTossApiRpc(
          createAppsInTossApi({
            mode: "forward",
            upstreamBaseUrl: "https://partner.example",
            mtlsClient,
            ...options
          })
        ),
        paths,
        headers,
        bodies
      };
    }

    test("prepare only issues a transaction key", async () => {
      const { api, paths, bodies } = recordingApi(async () =>
        Response.json({ resultType: "SUCCESS", success: { key: "transaction-key" } })
      );

      const response = await api.promotionPrepareReward({});

      expect(response).toEqual({ ok: true, providerTransactionKey: "transaction-key" });
      expect(paths).toEqual([TOSS_ENDPOINTS.promotionGetKey]);
      // The official get-key contract takes no request body.
      expect(bodies[0]).toBeUndefined();
    });

    test.each([
      ["no SUCCESS envelope", { key: "transaction-key" }, "was not a SUCCESS envelope"],
      ["a coerced numeric key", { resultType: "SUCCESS", success: { key: 123 } }, "did not include a string key"],
      ["a coerced array resultType", { resultType: ["SUCCESS"], success: { key: "transaction-key" } }, "was not a SUCCESS envelope"]
    ] as const)(
      "prepare rejects a get-key response with %s",
      async (_label, body, reasonFragment) => {
        const { api } = recordingApi(async () => Response.json(body));

        const response = await api.promotionPrepareReward({});

        expect(response).toMatchObject({
          ok: false,
          error: "INVALID_RESPONSE",
          failureReason: expect.stringContaining(reasonFragment)
        });
      }
    );

    test.each([-1, 1.5, Infinity] as const)(
      "rejects the configured tossPromotionAmount %s",
      async (configured) => {
        const { api, paths } = recordingApi(
          async () => Response.json({ resultType: "SUCCESS", success: { key: "transaction-key" } }),
          { tossPromotionAmount: configured }
        );

        await expect(
          api.promotionExecuteReward({
            providerTransactionKey: "transaction-key",
            promotionCode: "promo",
            tossUserKey: "user"
          })
        ).rejects.toMatchObject({ code: "INVALID_PROMOTION_AMOUNT", status: 400 });
        expect(paths).toEqual([]);
      }
    );

    test("rejects a whitespace-only configured tossPromotionCode", async () => {
      const { api, paths } = recordingApi(
        async () => Response.json({ resultType: "SUCCESS", success: { key: "transaction-key" } }),
        { tossPromotionCode: "   " }
      );

      await expect(
        api.promotionExecuteReward({
          providerTransactionKey: "transaction-key",
          amount: 1000,
          tossUserKey: "user"
        })
      ).rejects.toMatchObject({ code: "INVALID_PROMOTION_CODE", status: 400 });
      expect(paths).toEqual([]);
    });

    test("propagates invalid upstream URL configuration before dispatch", async () => {
      const api = createAppsInTossApiRpc(
        createAppsInTossApi({
          mode: "forward",
          upstreamBaseUrl: "not a url",
          mtlsClient: {
            async request() {
              throw new Error("requests must not be dispatched with a broken upstream URL");
            }
          }
        })
      );

      await expect(
        api.promotionExecuteReward({
          providerTransactionKey: "transaction-key",
          promotionCode: "promo",
          amount: 1000,
          tossUserKey: "user"
        })
      ).rejects.toThrow(TypeError);
      await expect(
        api.promotionRewardStatus({
          providerTransactionKey: "transaction-key",
          promotionCode: "promo",
          tossUserKey: "user"
        })
      ).rejects.toThrow(TypeError);
    });

    test("execute requires a key and never issues one", async () => {
      const missing = createAppsInTossApiRpc(createAppsInTossApi({ mode: "forward" }));
      await expect(
        missing.promotionExecuteReward({
          promotionCode: "promo",
          amount: 1000,
          tossUserKey: "user"
        } as never)
      ).rejects.toMatchObject({ code: "MISSING_TRANSACTION_KEY", status: 400 });

      const { api, paths, headers, bodies } = recordingApi(async () =>
        Response.json({ resultType: "SUCCESS", success: { key: "transaction-key" } })
      );
      const response = await api.promotionExecuteReward({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        amount: 1000,
        tossUserKey: "user"
      });

      expect(response).toEqual({ ok: true, result: "SUBMITTED", providerTransactionKey: "transaction-key" });
      expect(paths).toEqual([TOSS_ENDPOINTS.promotionExecute]);
      expect(headers[0].get("x-toss-user-key")).toBe("user");
      expect(bodies[0]).toEqual({ promotionCode: "promo", key: "transaction-key", amount: 1000 });
    });

    test("execute applies the recipient contract for anonymous users", async () => {
      const { api, headers } = recordingApi(async () =>
        Response.json({ resultType: "SUCCESS", success: { key: "transaction-key" } })
      );

      await api.promotionExecuteReward({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        amount: 1000,
        anonKey: "anon:stored-hash"
      });

      expect(headers[0].get("x-anon-key")).toBe("anon:stored-hash");
      expect(headers[0].get("x-toss-user-key")).toBeNull();
    });

    test("status performs zero key-issuing and zero execute calls", async () => {
      const { api, paths, headers } = recordingApi(async () =>
        Response.json({ resultType: "SUCCESS", success: "SUCCESS" })
      );

      const response = await api.promotionRewardStatus({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        tossUserKey: "user"
      });

      expect(response).toMatchObject({
        ok: true,
        status: "GRANTED",
        providerTransactionKey: "transaction-key"
      });
      expect(typeof (response as { checkedAt: number }).checkedAt).toBe("number");
      expect(response).not.toHaveProperty("grantedAt");
      expect(paths).toEqual([TOSS_ENDPOINTS.promotionResult]);
      expect(headers[0].get("x-toss-user-key")).toBe("user");
    });

    test.each([
      ["PENDING", "PENDING"],
      ["FAILED", "FAILED"]
    ] as const)("maps the provider status %s to %s", async (provider, status) => {
      const { api } = recordingApi(async () =>
        Response.json({ resultType: "SUCCESS", success: provider })
      );

      const response = await api.promotionRewardStatus({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        tossUserKey: "user"
      });

      expect(response).toMatchObject({ ok: true, status, providerTransactionKey: "transaction-key" });
    });

    test("maps error 4111 to NOT_FOUND", async () => {
      const { api } = recordingApi(async () =>
        Response.json({
          resultType: "FAIL",
          error: { errorCode: "4111", reason: "지급 내역을 찾을 수 없어요." }
        })
      );

      const response = await api.promotionRewardStatus({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        tossUserKey: "user"
      });

      expect(response).toMatchObject({
        ok: true,
        status: "NOT_FOUND",
        providerTransactionKey: "transaction-key",
        providerErrorCode: "4111"
      });
    });

    test("treats an unrecognized status enum as UNKNOWN, not FAILED", async () => {
      const { api } = recordingApi(async () =>
        Response.json({ resultType: "SUCCESS", success: "SOMETHING_ELSE" })
      );

      const response = await api.promotionRewardStatus({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        tossUserKey: "user"
      });

      expect(response).toMatchObject({
        ok: true,
        status: "UNKNOWN",
        providerTransactionKey: "transaction-key"
      });
    });

    test.each(["DONE", "COMPLETED", "SUCCEEDED", "GRANTED"] as const)(
      "treats the undocumented status alias %s as UNKNOWN",
      async (alias) => {
        const { api } = recordingApi(async () =>
          Response.json({ resultType: "SUCCESS", success: alias })
        );

        const response = await api.promotionRewardStatus({
          providerTransactionKey: "transaction-key",
          promotionCode: "promo",
          tossUserKey: "user"
        });

        expect(response).toMatchObject({ ok: true, status: "UNKNOWN" });
      }
    );

    test.each([
      ["an array status", { resultType: "SUCCESS", success: { status: ["SUCCESS"] } }],
      ["an object status", { resultType: "SUCCESS", success: { status: { code: "SUCCESS" } } }],
      ["an array resultType", { resultType: ["SUCCESS"], success: "SUCCESS" }]
    ] as const)("treats coerced evidence (%s) as UNKNOWN", async (_label, body) => {
      const { api } = recordingApi(async () => Response.json(body));

      const response = await api.promotionRewardStatus({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        tossUserKey: "user"
      });

      expect(response).toMatchObject({ ok: true, status: "UNKNOWN" });
    });

    test("treats a FAIL envelope with a malformed error code as UNKNOWN", async () => {
      const { api } = recordingApi(async () =>
        Response.json({ resultType: "FAIL", error: { errorCode: {}, reason: "malformed" } })
      );

      const response = await api.promotionExecuteReward({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        amount: 1000,
        tossUserKey: "user"
      });

      expect(response).toMatchObject({ ok: true, result: "UNKNOWN" });
      expect(response).not.toHaveProperty("providerErrorCode");
    });

    test.each([
      ["no resultType", { ok: false, error: { errorCode: "4111", reason: "x" } }],
      ["an ERROR resultType", { resultType: "ERROR", error: { errorCode: "4111", reason: "x" } }],
      ["an array errorCode", { resultType: "FAIL", error: { errorCode: ["4111"], reason: "x" } }]
    ] as const)("keeps 4111 with %s as UNKNOWN, not NOT_FOUND", async (_label, body) => {
      const { api } = recordingApi(async () => Response.json(body));

      const response = await api.promotionRewardStatus({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        tossUserKey: "user"
      });

      expect(response).toMatchObject({ ok: true, status: "UNKNOWN" });
    });

    test("keeps a 5xx response carrying error 4111 as UNKNOWN", async () => {
      const { api } = recordingApi(async () =>
        Response.json(
          { resultType: "FAIL", error: { errorCode: "4111", reason: "stale replica" } },
          { status: 503 }
        )
      );

      const response = await api.promotionRewardStatus({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        tossUserKey: "user"
      });

      expect(response).toMatchObject({
        ok: true,
        status: "UNKNOWN",
        providerErrorCode: "4111",
        upstreamStatus: 503
      });
    });

    test.each([
      ["no resultType", { success: "SUCCESS" }],
      ["an unrecognized resultType", { resultType: "WEIRD", success: "SUCCESS" }]
    ] as const)("keeps a 2xx status payload with %s as UNKNOWN", async (_label, body) => {
      const { api } = recordingApi(async () => Response.json(body));

      const response = await api.promotionRewardStatus({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        tossUserKey: "user"
      });

      expect(response).toMatchObject({ ok: true, status: "UNKNOWN" });
    });

    test("propagates factory failures that occur before dispatch", async () => {
      const api = createAppsInTossApiRpc(
        createAppsInTossApi({
          mode: "forward",
          upstreamBaseUrl: "https://partner.example",
          appId: "app-id",
          mtlsClientFactory: {
            forApp: async () => {
              throw new Error("factory boom");
            }
          }
        })
      );

      await expect(
        api.promotionExecuteReward({
          providerTransactionKey: "transaction-key",
          promotionCode: "promo",
          amount: 1000,
          tossUserKey: "user"
        })
      ).rejects.toThrow("factory boom");
      await expect(
        api.promotionRewardStatus({
          providerTransactionKey: "transaction-key",
          promotionCode: "promo",
          tossUserKey: "user"
        })
      ).rejects.toThrow("factory boom");
    });

    test.each([
      ["a numeric promotion code", 123],
      ["an object promotion code", { code: "promo" }]
    ] as const)("rejects %s instead of coercing it", async (_label, promotionCode) => {
      const { api, paths } = recordingApi(async () =>
        Response.json({ resultType: "SUCCESS", success: { key: "transaction-key" } })
      );

      await expect(
        api.promotionExecuteReward({
          providerTransactionKey: "transaction-key",
          promotionCode,
          amount: 1000,
          tossUserKey: "user"
        } as never)
      ).rejects.toMatchObject({ code: "INVALID_PROMOTION_CODE", status: 400 });
      expect(paths).toEqual([]);
    });

    test.each([
      ["a numeric transaction key", 123],
      ["an object transaction key", { key: "k" }]
    ] as const)("rejects %s instead of coercing it", async (_label, providerTransactionKey) => {
      const { api, paths } = recordingApi(async () =>
        Response.json({ resultType: "SUCCESS", success: { key: "transaction-key" } })
      );

      await expect(
        api.promotionExecuteReward({
          providerTransactionKey,
          promotionCode: "promo",
          amount: 1000,
          tossUserKey: "user"
        } as never)
      ).rejects.toMatchObject({ code: "INVALID_TRANSACTION_KEY", status: 400 });
      await expect(
        api.promotionRewardStatus({
          providerTransactionKey,
          promotionCode: "promo",
          tossUserKey: "user"
        } as never)
      ).rejects.toMatchObject({ code: "INVALID_TRANSACTION_KEY", status: 400 });
      expect(paths).toEqual([]);
    });

    test.each([
      ["a string amount", "1000"],
      ["a boolean amount", true]
    ] as const)("rejects %s instead of coercing it", async (_label, amount) => {
      const { api, paths } = recordingApi(async () =>
        Response.json({ resultType: "SUCCESS", success: { key: "transaction-key" } })
      );

      await expect(
        api.promotionExecuteReward({
          providerTransactionKey: "transaction-key",
          promotionCode: "promo",
          amount,
          tossUserKey: "user"
        } as never)
      ).rejects.toMatchObject({ code: "INVALID_PROMOTION_AMOUNT", status: 400 });
      expect(paths).toEqual([]);
    });

    test("rejects an explicitly invalid amount instead of applying the configured default", async () => {
      const { api, paths } = recordingApi(async () =>
        Response.json({ resultType: "SUCCESS", success: { key: "transaction-key" } }),
        { tossPromotionAmount: 500 }
      );

      await expect(
        api.promotionExecuteReward({
          providerTransactionKey: "transaction-key",
          promotionCode: "promo",
          amount: 0,
          tossUserKey: "user"
        })
      ).rejects.toMatchObject({ code: "INVALID_PROMOTION_AMOUNT", status: 400 });
      expect(paths).toEqual([]);
    });

    test("rethrows pre-dispatch configuration errors instead of reporting UNKNOWN", async () => {
      const api = createAppsInTossApiRpc(createAppsInTossApi({ mode: "forward" }));

      await expect(
        api.promotionExecuteReward({
          providerTransactionKey: "transaction-key",
          promotionCode: "promo",
          amount: 1000,
          tossUserKey: "user"
        })
      ).rejects.toMatchObject({ code: "MISSING_MTLS_CLIENT" });
      await expect(
        api.promotionRewardStatus({
          providerTransactionKey: "transaction-key",
          promotionCode: "promo",
          tossUserKey: "user"
        })
      ).rejects.toMatchObject({ code: "MISSING_MTLS_CLIENT" });
    });

    test("keeps the key and reports UNKNOWN when the status lookup fails", async () => {
      const { api } = recordingApi(async () =>
        Response.json({ message: "result service unavailable" }, { status: 503 })
      );

      const response = await api.promotionRewardStatus({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        tossUserKey: "user"
      });

      expect(response).toMatchObject({
        ok: true,
        status: "UNKNOWN",
        providerTransactionKey: "transaction-key",
        upstreamStatus: 503
      });
    });

    test("keeps the key and reports UNKNOWN when the status transport rejects", async () => {
      const { api } = recordingApi(async () => {
        throw new Error("connection reset");
      });

      const response = await api.promotionRewardStatus({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        tossUserKey: "user"
      });

      expect(response).toMatchObject({
        ok: true,
        status: "UNKNOWN",
        providerTransactionKey: "transaction-key",
        failureReason: "promotion status request failed: connection reset"
      });
    });

    test("keeps the key and reports UNKNOWN when an execute response is lost", async () => {
      const { api } = recordingApi(async () => {
        throw new Error("gateway timeout");
      });

      const response = await api.promotionExecuteReward({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        amount: 1000,
        tossUserKey: "user"
      });

      expect(response).toMatchObject({
        ok: true,
        result: "UNKNOWN",
        providerTransactionKey: "transaction-key",
        failureReason: "promotion execute request failed: gateway timeout"
      });
    });

    test("treats an execute 5xx as UNKNOWN, not a definite failure", async () => {
      const { api } = recordingApi(async () =>
        Response.json({ message: "execute service unavailable" }, { status: 503 })
      );

      const response = await api.promotionExecuteReward({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        amount: 1000,
        tossUserKey: "user"
      });

      expect(response).toMatchObject({
        ok: true,
        result: "UNKNOWN",
        providerTransactionKey: "transaction-key",
        upstreamStatus: 503
      });
    });

    test("surfaces an explicit execute rejection with the key preserved", async () => {
      const { api } = recordingApi(async () =>
        Response.json({
          resultType: "FAIL",
          error: { errorCode: "4112", reason: "프로모션 예산이 부족해요." }
        })
      );

      const response = await api.promotionExecuteReward({
        providerTransactionKey: "transaction-key",
        promotionCode: "promo",
        amount: 1000,
        tossUserKey: "user"
      });

      expect(response).toMatchObject({
        ok: false,
        providerStatus: "FAILED",
        providerTransactionKey: "transaction-key",
        providerErrorCode: "4112"
      });
    });

    test.each([
      ["forward", "MISSING_TRANSACTION_KEY"],
      ["stub", "MISSING_TRANSACTION_KEY"]
    ] as const)(
      "validates execute inputs identically in %s mode",
      async (mode, code) => {
        const api = createAppsInTossApiRpc(
          createAppsInTossApi({
            mode,
            upstreamBaseUrl: "https://partner.example",
            mtlsClient: {
              async request() {
                throw new Error("invalid promotion input must not reach the transport");
              }
            }
          })
        );

        await expect(
          api.promotionExecuteReward({ promotionCode: "promo", amount: 1000, tossUserKey: "user" } as never)
        ).rejects.toMatchObject({ code, status: 400 });
        await expect(
          api.promotionExecuteReward({ providerTransactionKey: "key", amount: 1000, tossUserKey: "user" } as never)
        ).rejects.toMatchObject({ code: "MISSING_PROMOTION_CODE", status: 400 });
        await expect(
          api.promotionExecuteReward({ providerTransactionKey: "key", promotionCode: "promo", tossUserKey: "user" } as never)
        ).rejects.toMatchObject({ code: "MISSING_PROMOTION_AMOUNT", status: 400 });
        await expect(
          api.promotionExecuteReward({
            providerTransactionKey: "key",
            promotionCode: "promo",
            amount: 1000,
            userKey: "u",
            anonKey: "a"
          } as never)
        ).rejects.toMatchObject({ code: "INVALID_PROMOTION_RECIPIENT", status: 400 });
      }
    );

    test("validates status inputs before any request", async () => {
      const api = createAppsInTossApiRpc(
        createAppsInTossApi({
          mode: "forward",
          upstreamBaseUrl: "https://partner.example",
          mtlsClient: {
            async request() {
              throw new Error("invalid promotion input must not reach the transport");
            }
          }
        })
      );

      await expect(api.promotionRewardStatus({ promotionCode: "promo" } as never)).rejects.toMatchObject({
        code: "MISSING_TRANSACTION_KEY",
        status: 400
      });
      await expect(
        api.promotionRewardStatus({ providerTransactionKey: "key", tossUserKey: "user" } as never)
      ).rejects.toMatchObject({ code: "MISSING_PROMOTION_CODE", status: 400 });
    });

    test("stub mode never claims a granted promotion", async () => {
      const api = createAppsInTossApiRpc(createAppsInTossApi({ mode: "stub", now: () => 123_456 }));

      await expect(api.promotionPrepareReward({})).resolves.toEqual({
        ok: true,
        providerTransactionKey: "stub-promotion-transaction-key",
        stub: true
      });
      await expect(
        api.promotionExecuteReward({
          providerTransactionKey: "stub-promotion-transaction-key",
          promotionCode: "promo",
          amount: 1000,
          tossUserKey: "user"
        })
      ).resolves.toEqual({
        ok: true,
        result: "SUBMITTED",
        providerTransactionKey: "stub-promotion-transaction-key",
        stub: true
      });
      await expect(
        api.promotionRewardStatus({
          providerTransactionKey: "stub-promotion-transaction-key",
          promotionCode: "promo",
          tossUserKey: "user"
        })
      ).resolves.toEqual({
        ok: true,
        status: "PENDING",
        providerTransactionKey: "stub-promotion-transaction-key",
        checkedAt: 123_456,
        stub: true
      });
    });
  });
});

describe("IAP provider evidence type validation", () => {
  test.each([
    ["an orderId array", { orderId: ["order-id"], status: "PAYMENT_COMPLETED" }],
    ["an orderId object", { orderId: { id: "order-id" }, status: "PAYMENT_COMPLETED" }],
    ["a numeric orderId", { orderId: 12345, status: "PAYMENT_COMPLETED" }],
    ["a status array", { orderId: "order-id", status: ["PAYMENT_COMPLETED"] }],
    ["a boolean status", { orderId: "order-id", status: true }],
    ["a sku array on a payable order", { orderId: "order-id", status: "PAYMENT_COMPLETED", sku: ["sku-a"] }],
    ["an object statusDeterminedAt", { orderId: "order-id", status: "PAYMENT_COMPLETED", statusDeterminedAt: { t: 1 } }]
  ] as const)("rejects %s as verification evidence", (_label, success) => {
    const response = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      { resultType: "SUCCESS", success }
    );

    expect(response).toMatchObject({
      ok: false,
      error: "INVALID_RESPONSE",
      orderId: "order-id",
      providerStatus: "ERROR"
    });
    expect(response).not.toMatchObject({ verified: true });
  });

  test.each([
    ["a NETWORK_ERROR envelope with a contradictory success payload", { resultType: "NETWORK_ERROR", success: { orderId: "order-id", status: "PAYMENT_COMPLETED" } }],
    ["a FAIL envelope with a success payload", { resultType: "FAIL", success: { orderId: "order-id", status: "PAYMENT_COMPLETED" }, error: { errorCode: "500" } }],
    ["a TIMEOUT envelope", { resultType: "TIMEOUT", success: { orderId: "order-id", status: "PAYMENT_COMPLETED" } }]
  ] as const)("never verifies %s", (_label, upstream) => {
    const response = normalizeIapOrderStatusResponse({ orderId: "order-id" }, upstream);

    expect(response.ok).toBe(false);
    expect(response).not.toMatchObject({ verified: true });
  });

  test("rejects an unrecognized envelope resultType even with a full success payload", () => {
    const response = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      { resultType: "OK", success: { orderId: "order-id", status: "PAYMENT_COMPLETED" } }
    );

    expect(response).toMatchObject({
      ok: false,
      error: "INVALID_RESPONSE",
      failureReason: expect.stringContaining("OK")
    });
  });

  test("missing optional evidence stays valid while wrong-typed evidence does not", () => {
    const clean = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      { resultType: "SUCCESS", success: { orderId: "order-id", status: "PURCHASED" } }
    );
    expect(clean).toMatchObject({ ok: true, verified: true });

    const wrongTypedSku = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      { resultType: "SUCCESS", success: { orderId: "order-id", status: "PURCHASED", sku: 42 } }
    );
    expect(wrongTypedSku).toMatchObject({ ok: false, error: "INVALID_RESPONSE" });
  });

  test("an explicit ok:false wins over a SUCCESS envelope with payable evidence", () => {
    const response = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      {
        ok: false,
        resultType: "SUCCESS",
        success: { orderId: "order-id", status: "PAYMENT_COMPLETED" }
      }
    );

    expect(response).toMatchObject({ ok: false, providerStatus: "ERROR" });
    expect(response).not.toMatchObject({ verified: true });
  });

  test("identifier evidence keeps the provider's exact bytes", () => {
    // A whitespace-padded provider orderId is NOT the requested order:
    // trimming is only used to reject blanks, never to create a match.
    const padded = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      { resultType: "SUCCESS", success: { orderId: " order-id ", status: "PAYMENT_COMPLETED" } }
    );
    expect(padded).toMatchObject({ ok: true, verified: false, verificationCode: "ORDER_ID_MISMATCH" });
    expect(padded).not.toHaveProperty("verified", true);

    const exact = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      { resultType: "SUCCESS", success: { orderId: "order-id", status: "PURCHASED", sku: "sku-a" } }
    );
    expect(exact).toMatchObject({ ok: true, verified: true, sku: "sku-a" });
  });

  test("a SUCCESS envelope with a primitive success never falls back to envelope fields", () => {
    const response = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      {
        resultType: "SUCCESS",
        success: "ok",
        orderId: "order-id",
        status: "PAYMENT_COMPLETED"
      }
    );

    expect(response).toMatchObject({ ok: false, error: "INVALID_RESPONSE" });
    expect(response).not.toMatchObject({ verified: true });
  });

  test("a SUCCESS envelope without a nested payload is invalid", () => {
    const response = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      { resultType: "SUCCESS", orderId: "order-id", status: "PAYMENT_COMPLETED" }
    );

    expect(response).toMatchObject({ ok: false, error: "INVALID_RESPONSE" });
  });

  test("legacy bare order objects without an envelope still verify", () => {
    const response = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      { orderId: "order-id", status: "PAYMENT_COMPLETED" }
    );

    expect(response).toMatchObject({ ok: true, verified: true, providerStatus: "PAYMENT_COMPLETED" });
  });

  test("network error responses keep the provider error code for diagnostics", () => {
    const response = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      { resultType: "NETWORK_ERROR", error: { errorCode: "9019", errorMessage: "gateway unreachable" } }
    );

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "ERROR",
      providerErrorCode: "9019",
      failureReason: "gateway unreachable"
    });
  });
});

describe("smart message send-result evidence validation", () => {
  test.each([
    ["an empty object", {}],
    ["an HTML error page", { raw: "<html><body>502 Bad Gateway</body></html>" }],
    ["a SUCCESS envelope without a send result", { resultType: "SUCCESS" }],
    ["a SUCCESS envelope with an empty result object", { resultType: "SUCCESS", success: {} }],
    ["an unrecognized resultType", { resultType: "WEIRD", success: { msgCount: 1 } }],
    ["a string msgCount", { resultType: "SUCCESS", success: { msgCount: "1" } }],
    ["an array msgCount", { resultType: "SUCCESS", success: { msgCount: [1] } }],
    ["a negative channel count", { resultType: "SUCCESS", success: { msgCount: 1, sentSmsCount: -3 } }],
    ["a NETWORK_ERROR envelope", { resultType: "NETWORK_ERROR" }],
    ["a TIMEOUT envelope", { resultType: "TIMEOUT" }]
  ] as const)("never reports %s as SENT", (_label, upstream) => {
    const response = normalizeMessageResponse({ providerRequestId: "req-1" }, upstream);

    expect(response.ok).toBe(false);
    expect(response.providerStatus).not.toBe("SENT");
    if (["an empty object", "an HTML error page", "a SUCCESS envelope without a send result", "a SUCCESS envelope with an empty result object", "an unrecognized resultType", "a string msgCount", "an array msgCount", "a negative channel count"].includes(_label)) {
      expect(response).toMatchObject({ providerStatus: "UNKNOWN", error: "INVALID_RESPONSE" });
    } else {
      expect(response).toMatchObject({ providerStatus: "UNKNOWN" });
    }
  });

  test("an explicit ok:false wins over count evidence for messages", () => {
    const response = normalizeMessageResponse(
      {},
      { ok: false, resultType: "SUCCESS", success: { msgCount: 1 } }
    );

    expect(response).toMatchObject({ ok: false, providerStatus: "FAILED" });
    expect(response).not.toMatchObject({ ok: true });
  });

  test("unknown results keep supplied timestamps but never add clock ones", () => {
    const response = normalizeMessageResponse(
      { requestedAt: 777 },
      { resultType: "TIMEOUT" },
      200,
      () => {
        throw new Error("the clock must not be consulted for unknown results");
      }
    );

    expect(response).toMatchObject({ ok: false, providerStatus: "UNKNOWN", sentAt: 777 });
  });

  test.each([
    ["ok:false with a providerStatus and a SUCCESS envelope", { ok: false, providerStatus: "FAILED", resultType: "SUCCESS", success: { msgCount: 1 } }],
    ["ok:false with a null providerStatus and counts", { ok: false, providerStatus: null, resultType: "SUCCESS", success: { msgCount: 1 } }],
    ["a provider FAILED status alongside a SUCCESS envelope", { providerStatus: "FAILED", resultType: "SUCCESS", success: { msgCount: 1 } }]
  ] as const)("treats %s as a stated failure, never SENT", (_label, upstream) => {
    const response = normalizeMessageResponse({}, upstream);

    expect(response).toMatchObject({ ok: false, providerStatus: "FAILED" });
    expect(response).not.toMatchObject({ ok: true });
  });

  test("bare top-level failure entries on a zero-send response report FAILED", () => {
    const response = normalizeMessageResponse({}, {
      msgCount: 0,
      fail: { sentSms: [{ contentId: "sms-1", reachedFailReason: "phone off" }] }
    });

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "FAILED",
      failureReason: "phone off",
      failures: [{ channel: "sentSms", contentId: "sms-1", reachedFailReason: "phone off" }]
    });
  });

  test.each(["FAIL", "ERROR", "REJECTED", "FAILED"] as const)(
    "treats a stated providerStatus %s next to a SUCCESS envelope as failure",
    async (status) => {
      const response = normalizeMessageResponse(
        {},
        { providerStatus: status, resultType: "SUCCESS", success: { msgCount: 1 } }
      );

      expect(response).toMatchObject({ ok: false, providerStatus: "FAILED" });
      expect(response).not.toMatchObject({ ok: true });
    }
  );

  test("a 5xx unknown carries the internal invalid-response marker", () => {
    const response = normalizeMessageResponse({}, { message: "gateway down" }, 503);

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "UNKNOWN",
      error: "INVALID_RESPONSE",
      upstreamStatus: 503
    });
  });

  test("padded IAP status enums still classify as payable and retryable", () => {
    const payable = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      { resultType: "SUCCESS", success: { orderId: "order-id", status: " PAYMENT_COMPLETED " } }
    );
    expect(payable).toMatchObject({ ok: true, verified: true, providerStatus: "PAYMENT_COMPLETED" });

    const pending = normalizeIapOrderStatusResponse(
      { orderId: "order-id" },
      { resultType: "SUCCESS", success: { orderId: "order-id", status: " ORDER_IN_PROGRESS " } }
    );
    expect(pending).toMatchObject({ ok: true, verified: false, verificationCode: "PAYMENT_INCOMPLETE" });
  });

  test("a padded stated failure status next to a SUCCESS envelope still fails", () => {
    const response = normalizeMessageResponse(
      {},
      { providerStatus: " FAILED ", resultType: "SUCCESS", success: { msgCount: 1 } }
    );

    expect(response).toMatchObject({ ok: false, providerStatus: "FAILED" });
  });

  test("a status-keyed contradictory normalized body is UNKNOWN, not FAILED", () => {
    const response = normalizeMessageResponse({}, { ok: false, status: "SENT" });

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "UNKNOWN",
      error: "INVALID_RESPONSE"
    });
  });

  test("a result-bearing ok:false body never becomes SENT", () => {
    const response = normalizeMessageResponse(
      {},
      { ok: false, providerStatus: "FAILED", result: { msgCount: 1 } }
    );

    expect(response).toMatchObject({ ok: false, providerStatus: "FAILED" });
    expect(response).not.toMatchObject({ ok: true });
  });

  test("bare top-level failure entries without counts report a definite failure", () => {
    const response = normalizeMessageResponse({}, {
      fail: { sentInbox: [{ contentId: "inbox-1", reachedFailReason: "inbox unavailable" }] }
    });

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "FAILED",
      failureReason: "inbox unavailable"
    });
  });

  test("lowercase or non-exact normalized status tokens never skip evidence checks", () => {
    const response = normalizeMessageResponse({}, { providerStatus: "sent" });

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "UNKNOWN",
      error: "INVALID_RESPONSE"
    });
  });

  test("a 3xx response stays UNKNOWN, only 4xx is a definite rejection", () => {
    const redirect = normalizeMessageResponse({}, {}, 302);
    expect(redirect).toMatchObject({ ok: false, providerStatus: "UNKNOWN", upstreamStatus: 302 });

    const rejected = normalizeMessageResponse({}, {}, 403);
    expect(rejected).toMatchObject({ ok: false, providerStatus: "FAILED", upstreamStatus: 403 });
  });

  test.each([
    ["a non-array channel", { msgCount: 0, fail: { sentSms: "phone off" } }],
    ["a non-object entry", { msgCount: 0, fail: { sentSms: ["phone off"] } }],
    ["a non-object fail", { msgCount: 0, fail: "unavailable" }]
  ] as const)("rejects %s in the failure collection", (_label, upstream) => {
    const response = normalizeMessageResponse(
      {},
      { resultType: "SUCCESS", success: upstream }
    );

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "UNKNOWN",
      error: "INVALID_RESPONSE",
      failureReason: expect.stringContaining("malformed failure collection")
    });
    expect(response).not.toMatchObject({ ok: true });
  });

  test("a status-alias failure next to a SUCCESS envelope still fails", () => {
    const response = normalizeMessageResponse(
      {},
      { status: "FAILED", resultType: "SUCCESS", success: { msgCount: 1 } }
    );

    expect(response).toMatchObject({ ok: false, providerStatus: "FAILED" });
    expect(response).not.toMatchObject({ ok: true });
  });

  test("nested results with top-level failure evidence are malformed hybrids", () => {
    const response = normalizeMessageResponse({}, {
      resultType: "SUCCESS",
      result: { msgCount: 0 },
      fail: { sentSms: [{ reachedFailReason: "phone off" }] }
    });

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "UNKNOWN",
      error: "INVALID_RESPONSE",
      failureReason: expect.stringContaining("both nested and at the top level")
    });
  });

  test.each([
    [
      "a nested FAIL resultType under a top-level SUCCESS",
      { resultType: "SUCCESS", success: { resultType: "FAIL", orderId: "order-id", status: "PAYMENT_COMPLETED" } }
    ]
  ] as const)("never verifies IAP evidence with %s", (_label, upstream) => {
    const response = normalizeIapOrderStatusResponse({ orderId: "order-id" }, upstream);

    expect(response).toMatchObject({ ok: false, error: "INVALID_RESPONSE" });
    expect(response).not.toMatchObject({ verified: true });
  });

  test("a SENT providerStatus cannot hide a FAILED status alias", () => {
    const response = normalizeMessageResponse(
      {},
      { providerStatus: "SENT", status: "FAILED", resultType: "SUCCESS", success: { msgCount: 1 } }
    );

    expect(response).toMatchObject({ ok: false, providerStatus: "FAILED" });
    expect(response).not.toMatchObject({ ok: true });
  });

  test("disagreeing non-failure status aliases invalidate the response", () => {
    const response = normalizeMessageResponse(
      {},
      { providerStatus: "SENT", status: "WEIRD", resultType: "SUCCESS", success: { msgCount: 1 } }
    );

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "UNKNOWN",
      error: "INVALID_RESPONSE",
      failureReason: expect.stringContaining("conflicting providerStatus and status aliases")
    });
  });

  test("a nested FAIL resultType under a top-level SUCCESS never sends", () => {
    const response = normalizeMessageResponse(
      {},
      { resultType: "SUCCESS", success: { resultType: "FAIL", msgCount: 1 } }
    );

    expect(response).toMatchObject({ ok: false, error: "INVALID_RESPONSE" });
    expect(response).not.toMatchObject({ ok: true });
  });

  test("unknown results keep correlation info but never fabricate a sentAt", () => {
    const response = normalizeMessageResponse(
      { providerRequestId: "req-9" },
      { resultType: "SUCCESS", success: {} },
      200,
      () => {
        throw new Error("the clock must not be consulted for unknown results");
      }
    );

    expect(response).toMatchObject({
      ok: false,
      providerRequestId: "req-9",
      providerStatus: "UNKNOWN",
      error: "INVALID_RESPONSE"
    });
    expect(response.sentAt).toBeUndefined();
  });

  test("an explicit zero-count response is a valid SENT, distinct from a missing result", () => {
    const response = normalizeMessageResponse({}, { resultType: "SUCCESS", success: { msgCount: 0 } });

    expect(response).toMatchObject({ ok: true, providerStatus: "SENT", msgCount: 0 });
  });

  test("a 5xx response stays UNKNOWN while a 4xx is a definite failure", () => {
    const serverError = normalizeMessageResponse({}, { message: "upstream exploded" }, 503);
    expect(serverError).toMatchObject({ ok: false, providerStatus: "UNKNOWN", upstreamStatus: 503 });
    expect(serverError.sentAt).toBeUndefined();

    const rejected = normalizeMessageResponse({}, { message: "bad template" }, 400);
    expect(rejected).toMatchObject({ ok: false, providerStatus: "FAILED", upstreamStatus: 400 });
  });

  test("explicit provider failures keep the provider error code, not an internal one", () => {
    const response = normalizeMessageResponse(
      {},
      { resultType: "FAIL", error: { errorCode: "4008", errorMessage: "invalid recipient" } }
    );

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "FAILED",
      providerErrorCode: "4008",
      failureReason: "invalid recipient"
    });
    expect(response).not.toHaveProperty("error");
  });

  test("partial success preserves channel results, failure reasons, and contentIds", () => {
    const response = normalizeMessageResponse(
      {},
      {
        resultType: "SUCCESS",
        success: {
          msgCount: 2,
          sentPushCount: 1,
          sentSmsCount: 0,
          detail: { sentPush: [{ contentId: "push-1" }] },
          fail: { sentSms: [{ contentId: "sms-1", reachedFailReason: "phone off" }] }
        }
      }
    );

    expect(response).toMatchObject({
      ok: true,
      providerStatus: "SENT",
      msgCount: 2,
      sentPushCount: 1,
      contentIds: ["push-1"],
      failures: [{ channel: "sentSms", contentId: "sms-1", reachedFailReason: "phone off" }]
    });
  });

  test("already-normalized SENT responses round-trip under their explicit rule", () => {
    const roundTrip = normalizeMessageResponse({}, {
      ok: true,
      providerStatus: "SENT",
      msgCount: 1,
      sentAt: 1234
    });
    expect(roundTrip).toMatchObject({ ok: true, providerStatus: "SENT" });

    const unknownStatus = normalizeMessageResponse({}, { providerStatus: "WEIRD", msgCount: 1 });
    expect(unknownStatus).toMatchObject({ ok: false, providerStatus: "UNKNOWN", error: "INVALID_RESPONSE" });
  });

  test("bulk sends share the same evidence rule through the forward path", async () => {
    const api = createAppsInTossApiRpc(
      createAppsInTossApi({
        mode: "forward",
        upstreamBaseUrl: "https://partner.example",
        mtlsClient: {
          async request() {
            return new Response("<html>gateway error</html>", {
              status: 200,
              headers: { "content-type": "text/html" }
            });
          }
        }
      })
    );

    const response = await api.smartMessageBulkSend({
      templateSetCode: "template",
      contextList: [{ userKey: "user-key", context: {} }]
    });

    expect(response).toMatchObject({
      ok: false,
      providerStatus: "UNKNOWN",
      error: "INVALID_RESPONSE"
    });
    expect(response).not.toMatchObject({ ok: true });
  });
});
