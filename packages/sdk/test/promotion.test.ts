import { describe, expect, test } from "bun:test";
import { createReactNativePromotion } from "../src/rn/promotion.js";
import { createWebPromotion } from "../src/web/promotion.js";
import { adaptOfficialRnPromotion } from "../src/rn/official-module.js";

const input = { promotionCode: "SYNTHETIC_TEST_CODE", amount: 10 };
for (const create of [createReactNativePromotion, createWebPromotion]) {
  describe(create.name, () => {
    test("reports missing capability, absent checker and explicit support distinctly", async () => {
      expect(await create({ framework: {} }).getSupport()).toBe("unsupported");
      expect(await create({ framework: { Promotion: { grantReward: async () => ({ key: "k" }) } } }).getSupport()).toBe("unknown");
      for (const supported of [true, false]) {
        let calls = 0;
        const adapter = create({ framework: { Promotion: { grantReward: Object.assign(async () => { calls++; return { key: "k" }; }, { isSupported: () => supported }) } } });
        expect(await adapter.getSupport()).toBe(supported ? "supported" : "unsupported");
        if (!supported) {
          await expect(adapter.grantReward(input)).rejects.toMatchObject({ code: "UNSUPPORTED" });
          expect(calls).toBe(0);
        }
      }
    });

    test("validates before loading, rejects whitespace changes and unsafe amounts", async () => {
      let loads = 0;
      const adapter = create({ framework: async () => { loads++; return { available: true, module: {} }; } });
      for (const amount of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(adapter.grantReward({ ...input, amount })).rejects.toMatchObject({ code: "INVALID_PROMOTION_INPUT" });
      }
      for (const promotionCode of ["", " ", " code", "code "]) {
        await expect(adapter.grantReward({ ...input, promotionCode })).rejects.toMatchObject({ code: "INVALID_PROMOTION_INPUT" });
      }
      expect(loads).toBe(0);
      for (const timeoutMs of [-1, NaN, Infinity, 0.5, 2_147_483_648]) {
        expect(() => create({ timeoutMs })).toThrow();
      }
    });

    test("normalizes results conservatively and never exposes provider messages", async () => {
      for (const [response, expected] of [
        [{ key: "reward-1" }, { status: "granted", rewardKey: "reward-1" }],
        ["ERROR", { status: "unknown", reason: "sdk_error" }],
        [null, { status: "unknown", reason: "invalid_response" }],
        [{ key: "" }, { status: "unknown", reason: "invalid_response" }],
        [{ key: " " }, { status: "unknown", reason: "invalid_response" }],
        [{ key: "k", errorCode: "4104" }, { status: "unknown", reason: "invalid_response", providerCode: "4104" }],
        [{ key: "k", error: "failure" }, { status: "unknown", reason: "invalid_response" }],
        [{ code: "4104", errorCode: "4114" }, { status: "unknown", reason: "invalid_response", providerCode: "4114" }],
        [{ errorCode: "4113", message: "private" }, { status: "unknown", reason: "ambiguous_provider_error", providerCode: "4113" }],
        [{ errorCode: "NEW_CODE", message: "private" }, { status: "unknown", reason: "ambiguous_provider_error", providerCode: "NEW_CODE" }],
        [{ code: "UNKNOWN_ERROR" }, { status: "unknown", reason: "ambiguous_provider_error", providerCode: "UNKNOWN_ERROR" }]
      ] as const) {
        const adapter = create({ framework: { Promotion: { grantReward: async () => response } } });
        expect(await adapter.grantReward(input)).toEqual(expected);
      }
      for (const code of ["4100", "4104", "4105", "4108", "4109", "4110", "4112", "4114"]) {
        for (const thrown of [true, false]) {
          const adapter = create({ framework: { Promotion: { grantReward: async () => {
            if (thrown) throw Object.assign(new Error("private"), { code });
            return { errorCode: code, message: "private" };
          } } } });
          expect(await adapter.grantReward(input)).toEqual({ status: "rejected", providerCode: code });
        }
      }
    });

    test("unknown throws stay unknown; unsupported errors stay observable", async () => {
      for (const error of [new Error("private"), "private", { code: "UNSUPPORTED_APP_VERSION" }]) {
        const adapter = create({ framework: { Promotion: { grantReward: () => { throw error; } } } });
        if (typeof error === "object" && "code" in error) {
          await expect(adapter.grantReward(input)).rejects.toMatchObject({ code: "UNSUPPORTED" });
        } else expect(await adapter.grantReward(input)).toEqual({ status: "unknown", reason: "sdk_error" });
      }
    });

    test("captures input before loading and rejects concurrent calls without caching results", async () => {
      let finish!: (value: unknown) => void;
      let calls = 0;
      const pending = new Promise(resolve => { finish = resolve; });
      const grantReward = Object.assign(function(this: unknown, received: typeof input) {
        expect(this).toBe(domain); expect(received).toEqual(input); calls++; return pending;
      }, { isSupported() { expect(this).toBe(grantReward); return true; } });
      const domain = { grantReward };
      const adapter = create({ framework: { Promotion: domain } });
      const mutable = { ...input };
      const first = adapter.grantReward(mutable);
      mutable.amount = 99;
      await expect(adapter.grantReward(input)).rejects.toMatchObject({ code: "PROMOTION_IN_PROGRESS" });
      await Bun.sleep(0);
      expect(calls).toBe(1);
      finish({ key: "k" });
      await first;
      await adapter.grantReward(input);
      expect(calls).toBe(2);
    });

    test("timeout retains the lock until late success or rejection settles", async () => {
      for (const rejects of [false, true]) {
        let settle!: () => void;
        let calls = 0;
        const pending = new Promise((resolve, reject) => { settle = () => rejects ? reject(new Error("private")) : resolve({ key: "late" }); });
        const adapter = create({ timeoutMs: 5, framework: { Promotion: { grantReward: () => { calls++; return pending; } } } });
        const result = await adapter.grantReward(input);
        expect(result).toEqual({ status: "unknown", reason: "timeout" });
        await expect(adapter.grantReward(input)).rejects.toMatchObject({ code: "PROMOTION_IN_PROGRESS" });
        expect(calls).toBe(1);
        settle();
        await Bun.sleep(0);
        await adapter.grantReward(input);
        expect(calls).toBe(2);
        expect(result).toEqual({ status: "unknown", reason: "timeout" });
      }
    });

    test("loading timeout never launches payment late and load failure is retryable", async () => {
      let resolve!: (value: { available: true; module: { Promotion: { grantReward: () => Promise<unknown> } } }) => void;
      let calls = 0;
      const adapter = create({ timeoutMs: 5, framework: () => new Promise(r => { resolve = r; }) });
      expect(await adapter.grantReward(input)).toEqual({ status: "unknown", reason: "timeout" });
      await expect(adapter.grantReward(input)).rejects.toMatchObject({ code: "PROMOTION_IN_PROGRESS" });
      resolve({ available: true, module: { Promotion: { grantReward: async () => { calls++; return { key: "k" }; } } } });
      await Bun.sleep(0);
      expect(calls).toBe(0);
      let loads = 0;
      const retry = create({ framework: async () => ++loads === 1 ? { available: false, reason: "unavailable" } : { available: true, module: {} } });
      await expect(retry.grantReward(input)).rejects.toMatchObject({ code: "SDK_UNAVAILABLE" });
      expect(await retry.getSupport()).toBe("unsupported");
    });
  });
}

test("RN conversion wraps params, preserves receiver and treats undefined as unsupported", async () => {
  const official = { grantPromotionReward(this: unknown, params: { params: typeof input }) {
    expect(this).toBe(official); expect(params).toEqual({ params: input });
    return Promise.resolve({ key: "rn-key" });
  } };
  const adapter = createReactNativePromotion({ framework: adaptOfficialRnPromotion(official) });
  expect(await adapter.getSupport()).toBe("unknown");
  expect(await adapter.grantReward(input)).toEqual({ status: "granted", rewardKey: "rn-key" });
  const unsupported = createReactNativePromotion({ framework: adaptOfficialRnPromotion({ grantPromotionReward: async () => undefined }) });
  await expect(unsupported.grantReward(input)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  const web = createWebPromotion({ framework: { Promotion: { grantReward: async () => undefined } } });
  expect(await web.grantReward(input)).toEqual({ status: "unknown", reason: "invalid_response" });
});
