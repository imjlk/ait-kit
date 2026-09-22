import { describe, expect, test } from "bun:test";
import { createReactNativeReview } from "../src/rn/review.js";
import { createWebReview } from "../src/web/review.js";
import { adaptOfficialRnReview } from "../src/rn/official-module.js";

for (const create of [createReactNativeReview, createWebReview]) {
  describe(create.name, () => {
    test("missing feature/checker or false support never requests", async () => {
      let calls = 0;
      for (const framework of [{}, { Review: {} }, { Review: { request: async () => { calls++; } } },
        { Review: { request: Object.assign(async () => { calls++; }, { isSupported: () => false }) } }]) {
        const review = create({ framework });
        expect(await review.isSupported()).toBe(false);
        await expect(review.request()).rejects.toMatchObject({ code: "UNSUPPORTED" });
      }
      expect(calls).toBe(0);
    });

    test("rechecks support and preserves method/checker receivers", async () => {
      let enabled = true;
      let calls = 0;
      const request = Object.assign(function(this: unknown) {
        expect(this).toBe(domain);
        calls++;
        return Promise.resolve();
      }, { isSupported() { expect(this).toBe(request); return enabled; } });
      const domain = { request };
      const review = create({ framework: { Review: domain } });
      expect(await review.isSupported()).toBe(true);
      enabled = false;
      await expect(review.request()).rejects.toMatchObject({ code: "UNSUPPORTED" });
      expect(calls).toBe(0);
      enabled = true;
      expect(await review.request()).toBeUndefined();
      expect(calls).toBe(1);
    });

    test("locks before loading, shares pending work and clears after completion", async () => {
      let calls = 0;
      let loads = 0;
      let finish!: () => void;
      const pending = new Promise<void>(resolve => { finish = resolve; });
      const review = create({ framework: async () => {
        loads++;
        return { available: true, module: { Review: { request: Object.assign(() => {
          calls++; return pending;
        }, { isSupported: () => true }) } } };
      } });
      const first = review.request();
      expect(review.request()).toBe(first);
      expect(review.request()).toBe(first);
      await Bun.sleep(0);
      expect(loads).toBe(1);
      expect(calls).toBe(1);
      finish();
      expect(await first).toBeUndefined();
      await review.request();
      expect(calls).toBe(2);
    });

    test("sync errors, rejections and support errors remain observable and unlock", async () => {
      const failure = new Error("fixture failure");
      for (const fail of [() => { throw failure; }, () => Promise.reject(failure)]) {
        let fails = true;
        const review = create({ framework: { Review: { request: Object.assign(
          () => fails ? fail() : Promise.resolve(), { isSupported: () => true }
        ) } } });
        await expect(review.request()).rejects.toBe(failure);
        fails = false;
        await expect(review.request()).resolves.toBeUndefined();
      }
      let fails = true;
      const review = create({ framework: { Review: { request: Object.assign(async () => {}, {
        isSupported: () => { if (fails) throw failure; return true; }
      }) } } });
      await expect(review.isSupported()).rejects.toBe(failure);
      await expect(review.request()).rejects.toBe(failure);
      fails = false;
      await expect(review.request()).resolves.toBeUndefined();
    });

    test("failed load is observable and a later call retries", async () => {
      let attempts = 0;
      const review = create({ framework: async () => ++attempts <= 2
        ? { available: false, reason: "fixture unavailable" }
        : { available: true, module: { Review: { request: Object.assign(async () => {}, { isSupported: () => true }) } } }
      });
      await expect(review.isSupported()).rejects.toMatchObject({ code: "SDK_UNAVAILABLE" });
      await expect(review.request()).rejects.toMatchObject({ code: "SDK_UNAVAILABLE" });
      await expect(review.request()).resolves.toBeUndefined();
    });
  });
}

test("RN conversion uses the flat function and retains both receivers", async () => {
  let calls = 0;
  const requestReview = Object.assign(function(this: unknown) {
    expect(this).toBe(module); calls++; return Promise.resolve();
  }, { isSupported() { expect(this).toBe(requestReview); return true; } });
  const module = { requestReview };
  const review = createReactNativeReview({ framework: adaptOfficialRnReview(module) });
  expect(await review.isSupported()).toBe(true);
  await review.request();
  expect(calls).toBe(1);
  expect(await createReactNativeReview({ framework: adaptOfficialRnReview({}) }).isSupported()).toBe(false);
});
