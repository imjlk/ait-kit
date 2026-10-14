import { expect, test } from "bun:test";
import { exchangeAnonAuthCode, type MtlsClient } from "../src";

function transport(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const mtlsClient: MtlsClient = { async request(url, init) {
    calls.push({ url, init });
    return Response.json(body, { status });
  } };
  return { calls, mtlsClient };
}

test("exchanges the code once and preserves only the server identity", async () => {
  const stub = transport({ resultType: "SUCCESS", success: { anonKey: "opaque-key", name: "ignored" } });
  expect(await exchangeAnonAuthCode({ code: "one-time-code" }, { mode: "forward", ...stub })).toEqual({ ok: true, anonKey: "opaque-key" });
  expect(stub.calls).toHaveLength(1);
  expect(stub.calls[0]?.url).toBe("https://apps-in-toss-api.toss.im/api-partner/v1/apps-in-toss/users/anon-key/exchange");
  expect(stub.calls[0]?.init.method).toBe("POST");
  expect(JSON.parse(String(stub.calls[0]?.init.body))).toEqual({ code: "one-time-code" });
});

for (const body of [
  { resultType: "FAIL", success: { anonKey: "forged" } },
  { resultType: "HTTP_TIMEOUT", success: { anonKey: "forged" } },
  { success: { anonKey: "forged" } },
  { resultType: "SUCCESS", success: { hash: "wrong-shape" } },
  { resultType: "SUCCESS", success: { anonKey: " " } },
  { resultType: "SUCCESS", success: { anonKey: 123 } }
]) {
  test(`rejects non-authoritative response ${JSON.stringify(body)}`, async () => {
    const stub = transport(body);
    expect((await exchangeAnonAuthCode({ code: "test-code" }, { mode: "forward", ...stub })).ok).toBe(false);
    expect(stub.calls).toHaveLength(1);
  });
}

test("never authenticates a success payload from a failed HTTP response", async () => {
  const stub = transport({ resultType: "SUCCESS", success: { anonKey: "forged" } }, 401);
  expect((await exchangeAnonAuthCode({ code: "test-code" }, { mode: "forward", ...stub })).ok).toBe(false);
});

test("does not fabricate identities in default/stub mode or send invalid codes", async () => {
  const stub = transport({});
  expect(await exchangeAnonAuthCode({ code: "test-code" }, stub)).toEqual({ ok: false, error: "FORWARD_MODE_REQUIRED" });
  expect(await exchangeAnonAuthCode({ code: " " }, { mode: "forward", ...stub })).toEqual({ ok: false, error: "INVALID_AUTH_CODE" });
  expect(stub.calls).toHaveLength(0);
});

test("does not retry single-use codes or expose transport secrets", async () => {
  let calls = 0;
  const result = await exchangeAnonAuthCode({ code: "test-code" }, { mode: "forward", mtlsClient: { async request() {
    calls++; throw new Error("private-auth-code-and-provider-details");
  } } });
  expect(result).toEqual({ ok: false, error: "UPSTREAM_UNAVAILABLE" });
  expect(calls).toBe(1);
});

test("honors cancellation before dispatch and after transport completion", async () => {
  const aborted = new AbortController(); aborted.abort();
  const stub = transport({});
  await exchangeAnonAuthCode({ code: "test-code" }, { mode: "forward", ...stub, signal: aborted.signal });
  expect(stub.calls).toHaveLength(0);
  const controller = new AbortController();
  const result = await exchangeAnonAuthCode({ code: "test-code" }, { mode: "forward", signal: controller.signal, mtlsClient: { async request(_url, init) {
    expect(init.signal).toBe(controller.signal);
    controller.abort();
    return Response.json({ resultType: "SUCCESS", success: { anonKey: "late-identity" } });
  } } });
  expect(result.ok).toBe(false);
});
