import { describe, expect, test } from "bun:test";
import { createReactNativeIdentity, createReactNativeStorage } from "../src/rn";
import { createWebIdentity, createWebStorage } from "../src/web";

function fakeIdentityPlatform(overrides: {
  loginImpl?: () => Promise<unknown>;
  loginSupported?: boolean;
  keyImpl?: () => Promise<unknown>;
  keySupported?: boolean;
} = {}) {
  return {
    TossAuth: {
      login: Object.assign(
        overrides.loginImpl ?? (async () => ({ authorizationCode: "code-1", referrer: "DEFAULT" })),
        { isSupported: () => overrides.loginSupported ?? true }
      )
    },
    User: {
      getAnonymousKey: Object.assign(
        overrides.keyImpl ?? (async () => ({ type: "HASH", hash: "hash-1" })),
        { isSupported: () => overrides.keySupported ?? true }
      )
    }
  };
}

function fakeStoragePlatform(overrides: { failOn?: "set" | "remove" | "get" } = {}) {
  const store = new Map<string, string>();
  const maybeFail = (op: "set" | "remove" | "get") => {
    if (overrides.failOn === op) {
      throw new Error(`${op} failed`);
    }
  };
  return {
    Storage: {
      getItem: async (key: string) => {
        maybeFail("get");
        return store.get(key) ?? null;
      },
      setItem: async (key: string, value: string) => {
        maybeFail("set");
        store.set(key, value);
      },
      removeItem: async (key: string) => {
        maybeFail("remove");
        store.delete(key);
      }
    },
    store
  };
}

describe("@ait-kit/sdk identity adapters", () => {
  test("validates and preserves a successful login result", async () => {
    const identity = createReactNativeIdentity({
      framework: fakeIdentityPlatform()
    });

    await expect(identity.login()).resolves.toEqual({
      authorizationCode: "code-1",
      referrer: "DEFAULT"
    });
  });

  test.each([
    ["empty authorizationCode", { authorizationCode: "", referrer: "DEFAULT" }],
    ["missing authorizationCode", { referrer: "SANDBOX" }],
    ["unrecognized referrer", { authorizationCode: "code-1", referrer: "OTHER" }],
    ["non-string referrer", { authorizationCode: "code-1", referrer: 3 }]
  ] as const)("rejects a login result with %s", async (_label, result) => {
    const identity = createReactNativeIdentity({
      framework: fakeIdentityPlatform({ loginImpl: async () => result })
    });

    await expect(identity.login()).rejects.toMatchObject({
      name: "SdkError",
      code: "INVALID_LOGIN_RESULT"
    });
  });

  test("propagates SDK login rejections unchanged", async () => {
    const sdkError = new Error("login cancelled");
    const identity = createReactNativeIdentity({
      framework: fakeIdentityPlatform({
        loginImpl: () => Promise.reject(sdkError)
      })
    });

    await expect(identity.login()).rejects.toBe(sdkError);
  });

  test("rejects with UNSUPPORTED when login is not supported", async () => {
    const identity = createReactNativeIdentity({
      framework: fakeIdentityPlatform({ loginSupported: false })
    });

    await expect(identity.login()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  test.each([
    ["an undefined result", undefined],
    ["an ERROR sentinel", "ERROR"],
    ["a HASH type with an empty hash", { type: "HASH", hash: "" }],
    ["a HASH type with a non-string hash", { type: "HASH", hash: 42 }],
    ["a non-HASH type", { type: "OTHER", hash: "abc" }]
  ] as const)("rejects an anonymous key result that is %s", async (_label, result) => {
    const identity = createReactNativeIdentity({
      framework: fakeIdentityPlatform({ keyImpl: async () => result })
    });

    await expect(identity.getAnonymousKey()).rejects.toMatchObject({
      name: "SdkError",
      code: "INVALID_ANONYMOUS_KEY"
    });
  });

  test("never fabricates a key and propagates SDK rejections", async () => {
    const sdkError = new Error("user domain unavailable");
    const identity = createReactNativeIdentity({
      framework: fakeIdentityPlatform({ keyImpl: () => Promise.reject(sdkError) })
    });

    await expect(identity.getAnonymousKey()).rejects.toBe(sdkError);
  });

  test("rejects with UNSUPPORTED in unsupported anonymous-key environments", async () => {
    const identity = createReactNativeIdentity({
      framework: fakeIdentityPlatform({ keySupported: false })
    });

    await expect(identity.getAnonymousKey()).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("anonymous keys")
    });
  });

  test("web identity rejects with SDK_UNAVAILABLE without the web SDK", async () => {
    const identity = createWebIdentity({
      framework: async () => ({ available: false, reason: "web sdk missing" })
    });

    await expect(identity.login()).rejects.toMatchObject({
      code: "SDK_UNAVAILABLE",
      message: "web sdk missing"
    });
    await expect(identity.getAnonymousKey()).rejects.toMatchObject({ code: "SDK_UNAVAILABLE" });
  });

  test("web identity works with an injected module", async () => {
    const identity = createWebIdentity({ framework: fakeIdentityPlatform() });

    await expect(identity.getAnonymousKey()).resolves.toEqual({ type: "HASH", hash: "hash-1" });
  });
});

describe("@ait-kit/sdk storage adapters", () => {
  test("get/set/remove with verbatim keys and null for missing keys", async () => {
    const platform = fakeStoragePlatform();
    const storage = createReactNativeStorage({ framework: platform });

    expect(await storage.get("exact-key")).toBeNull();
    await storage.set("exact-key", "value-1");
    expect(await storage.get("exact-key")).toBe("value-1");
    expect(platform.store.has("exact-key")).toBe(true);
    await storage.remove("exact-key");
    expect(await storage.get("exact-key")).toBeNull();
  });

  test.each(["set", "remove", "get"] as const)("propagates %s failures to the caller", async (op) => {
    const storage = createReactNativeStorage({ framework: fakeStoragePlatform({ failOn: op }) });

    const action =
      op === "set"
        ? storage.set("k", "v")
        : op === "remove"
          ? storage.remove("k")
          : storage.get("k");
    await expect(action).rejects.toThrow(`${op} failed`);
  });

  test("rejects a platform without the full get/set/remove surface", async () => {
    const storage = createReactNativeStorage({
      framework: { Storage: { getItem: async () => null } } as never
    });

    await expect(storage.get("k")).rejects.toMatchObject({
      name: "SdkError",
      message: expect.stringContaining("Storage get/set/remove")
    });
  });

  test("web storage works with an injected module", async () => {
    const platform = fakeStoragePlatform();
    const storage = createWebStorage({ framework: platform });

    await storage.set("web-key", "v");
    expect(await storage.get("web-key")).toBe("v");
  });

  test("web storage rejects with SDK_UNAVAILABLE without the web SDK", async () => {
    const storage = createWebStorage({
      framework: async () => ({ available: false, reason: "no web sdk" })
    });

    await expect(storage.set("k", "v")).rejects.toMatchObject({
      code: "SDK_UNAVAILABLE",
      message: "no web sdk"
    });
  });

  test("no environment guessing: missing functions stay missing", async () => {
    const identity = createReactNativeIdentity({ framework: {} });
    await expect(identity.login()).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("TossAuth.login")
    });
    await expect(identity.getAnonymousKey()).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("User.getAnonymousKey")
    });
  });
});
