import { expect, test } from "bun:test";
import { createWebViewIdentity } from "../src/webview";

test("preserves the SDK receiver and gets a fresh code on every request", async () => {
  const user = { getAnonymousKey: undefined, counter: 0, async createAnonymousKeyAuthCode() {
    return { code: `code-${++this.counter}`, expiresIn: 300 };
  } };
  const identity = createWebViewIdentity({ framework: { User: user } });
  expect(await identity.createAnonymousKeyAuthCode()).toEqual({ code: "code-1", expiresIn: 300 });
  expect(await identity.createAnonymousKeyAuthCode()).toEqual({ code: "code-2", expiresIn: 300 });
});

test("old SDKs never fall back to the unauthenticated hash or login", async () => {
  let calls = 0;
  const identity = createWebViewIdentity({ framework: {
    User: { getAnonymousKey: async () => { calls++; return { type: "HASH", hash: "unsafe" }; } },
    TossAuth: { login: async () => { calls++; return {}; } }
  } });
  await expect(identity.createAnonymousKeyAuthCode()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(calls).toBe(0);
});

test("honors runtime support before requesting a code", async () => {
  let calls = 0;
  const identity = createWebViewIdentity({ framework: { User: { getAnonymousKey: undefined,
    createAnonymousKeyAuthCode: Object.assign(async () => { calls++; return {}; }, { isSupported: () => false })
  } } });
  await expect(identity.createAnonymousKeyAuthCode()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(calls).toBe(0);
});

for (const value of [null, {}, { code: "secret-code", expiresIn: 0 }, { code: "secret-code", expiresIn: Infinity },
  { code: "secret-code", expiresIn: 1.5 }, { code: " ", expiresIn: 300 }, { code: 123, expiresIn: 300 }]) {
  test(`rejects malformed auth code ${JSON.stringify(value)}`, async () => {
    const identity = createWebViewIdentity({ framework: { User: { getAnonymousKey: undefined, createAnonymousKeyAuthCode: async () => value } } });
    try { await identity.createAnonymousKeyAuthCode(); throw new Error("unexpected success"); }
    catch (error) {
      expect(error).toMatchObject({ code: "INVALID_ANONYMOUS_AUTH_CODE" });
      expect(String(error)).not.toContain("secret-code");
    }
  });
}
