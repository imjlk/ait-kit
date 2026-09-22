import { expect, test, describe } from "bun:test";
import { createReactNativeIap } from "../src/rn";
import { createWebViewIap } from "../src/webview";

const snapshot = { catalogId: 1, status: "ACTIVE", expiresAt: null, isAutoRenew: true, gracePeriodExpiresAt: null, isAccessible: true };
for (const create of [createReactNativeIap, createWebViewIap]) {
  describe(create.name + " subscription info", () => {
    test("preserves provider status and access independently without granting", async () => {
      let grants = 0;
      const framework = { async getSubscriptionInfo(input: unknown) {
        expect(this).toBe(framework);
        expect(input).toEqual({ params: { orderId: "order" } });
        return { subscription: { ...snapshot, status: "FUTURE_STATE", isAccessible: false } };
      } };
      const iap = create({ framework, grant: async () => { grants++; } });
      expect(await iap.getSubscriptionInfo("order")).toEqual({ subscription: { ...snapshot, status: "FUTURE_STATE", isAccessible: false } });
      expect(grants).toBe(0);
    });
    test("gates missing functions, unsupported hosts and undefined RN responses", async () => {
      for (const framework of [{}, { getSubscriptionInfo: Object.assign(async () => { throw new Error("must not call"); }, { isSupported: () => false }) }, { getSubscriptionInfo: async () => undefined }, { getSubscriptionInfo: async () => { throw { code: "UNSUPPORTED_APP_VERSION" }; } }]) {
        await expect(create({ framework, grant: async () => {} }).getSubscriptionInfo("order")).rejects.toMatchObject({ code: "UNSUPPORTED" });
      }
    });
    test("validates input before acquiring SDK and keeps transient errors", async () => {
      let loads = 0;
      const error = new Error("network");
      const iap = create({ framework: async () => { loads++; return { available: true, module: { getSubscriptionInfo: async () => { throw error; } } }; }, grant: async () => {} });
      await expect(iap.getSubscriptionInfo(" ")).rejects.toMatchObject({ code: "INVALID_IAP_INPUT" });
      expect(loads).toBe(0);
      await expect(iap.getSubscriptionInfo("order")).rejects.toBe(error);
    });
    test("rejects malformed responses and returns a detached snapshot", async () => {
      for (const value of [null, {}, { subscription: null }, { subscription: { ...snapshot, status: 1 } }, { subscription: { ...snapshot, isAccessible: "true" } }, { subscription: { ...snapshot, catalogId: NaN } }]) {
        await expect(create({ framework: { getSubscriptionInfo: async () => value }, grant: async () => {} }).getSubscriptionInfo("order")).rejects.toMatchObject({ code: "INVALID_IAP_RESULT" });
      }
      const provider = { ...snapshot };
      const result = await create({ framework: { getSubscriptionInfo: async () => ({ subscription: provider }) }, grant: async () => {} }).getSubscriptionInfo("order");
      expect(result.subscription).toEqual(provider);
      expect(result.subscription).not.toBe(provider);
    });
  });
}
