import { describe, expect, mock, test } from "bun:test";
import {
  createReactNativeIdentity,
  createReactNativeNotification,
  createReactNativeShare
} from "../src/rn";
import { adaptOfficialRnIdentity } from "../src/rn/official-module.js";
import { officialModule } from "./helpers/official-fake.js";

// bun applies the first mock.module registration to dynamic imports and
// the imported module namespace is cached after the first import, so only
// ONE default-loader shape can be exercised per run. This file covers the
// populated official shape; missing-capability behavior is covered by the
// conversion tests (rn-official-module.test.ts) and by the tarball stub
// fixture in scripts/test-package-tarballs.mjs.
const official = officialModule();
mock.module("@apps-in-toss/framework", () => official);

describe("RN default loaders convert the official module shape", () => {
  test("identity, notification, and share work through the default loader", async () => {
    const identity = createReactNativeIdentity();
    await expect(identity.login()).resolves.toEqual({
      authorizationCode: "code-1",
      referrer: "SANDBOX"
    });

    const share = createReactNativeShare();
    await expect(share.createLink("intoss://my-app")).resolves.toBe(
      "https://toss.im/share/intoss://my-app"
    );
    // Positional official arguments reached the real function.
    expect(official.calls.getTossShareLink).toEqual([["intoss://my-app", "official-module"]]);

    const notification = createReactNativeNotification({ timeoutMs: 30 });
    const promise = notification.requestAgreement("TEMPLATE_1");
    await Bun.sleep(1);
    const { params } = official.calls.requestNotificationAgreement[0] as {
      params: { onEvent: (e: { type: string }) => void };
    };
    params.onEvent({ type: "agreementRejected" });
    await expect(promise).resolves.toMatchObject({ status: "rejected", templateCode: "TEMPLATE_1" });
  });

  // Note: bun's mock.module invokes its factory once at registration and
  // cannot serve a rejecting import, so the default loader's own
  // fail-then-retry behavior is not mockable here. The test below uses an
  // injected loader with the same retry/caching contract the default
  // loader implements.
  test("adapters retry after a failed load and reuse a successful one", async () => {
    let loads = 0;
    let loaded: ReturnType<typeof adaptOfficialRnIdentity> | undefined;
    const loader = async () => {
      if (loaded) {
        return { available: true as const, module: loaded };
      }
      loads += 1;
      if (loads === 1) {
        return { available: false as const, reason: "framework not ready" };
      }
      loaded = adaptOfficialRnIdentity(officialModule());
      return { available: true as const, module: loaded };
    };

    const identity = createReactNativeIdentity({ framework: loader });
    await expect(identity.login()).rejects.toMatchObject({
      code: "SDK_UNAVAILABLE",
      message: expect.stringContaining("framework not ready")
    });
    // The failed load was not cached: the retry reaches the module.
    await expect(identity.login()).resolves.toMatchObject({ authorizationCode: "code-1" });
    // A caching loader serves further calls without new loads.
    const before = loads;
    await expect(identity.login()).resolves.toMatchObject({ authorizationCode: "code-1" });
    expect(loads).toBe(before);
  });
});
