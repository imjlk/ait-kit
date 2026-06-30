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

  test("builds absolute Toss URLs for forward login flow", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mtlsClient: MtlsClient = {
      async request(url, init) {
        calls.push({ url, init });
        if (url.endsWith(TOSS_ENDPOINTS.loginGenerateToken)) {
          return Response.json({ success: { accessToken: "access-token" } });
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
    expect(calls.map((call) => call.url)).toEqual([
      "https://partner.example/api-partner/v1/apps-in-toss/user/oauth2/generate-token",
      "https://partner.example/api-partner/v1/apps-in-toss/user/oauth2/login-me"
    ]);
    expect(calls[1]?.init.headers).toMatchObject({ authorization: "Bearer access-token" });
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
});

