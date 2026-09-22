import { expect, mock, test } from "bun:test";
import { createWebViewReview } from "../src/webview/review.js";

import { createWebViewPromotion } from "../src/webview/promotion.js";

let calls = 0;
const request = Object.assign(function(this: unknown) {
  expect(this).toBe(Review);
  calls++;
  return Promise.resolve();
}, { isSupported() { expect(this).toBe(request); return true; } });
const Review = { request };
const Promotion = { grantReward: Object.assign(async function(this: unknown, input: unknown) {
  expect(this).toBe(Promotion);
  expect(input).toEqual({ promotionCode: "SYNTHETIC", amount: 1 });
  return { key: "web-reward" };
}, { isSupported: () => true }) };
mock.module("@apps-in-toss/web-framework", () => ({ Review, Promotion }));

test("WebView default loader calls the official object API", async () => {
  const review = createWebViewReview();
  expect(await review.isSupported()).toBe(true);
  await expect(review.request()).resolves.toBeUndefined();
  expect(calls).toBe(1);
});

test("WebView promotion default loader uses the namespaced API", async () => {
  const promotion = createWebViewPromotion();
  expect(await promotion.getSupport()).toBe("supported");
  expect(await promotion.grantReward({ promotionCode: "SYNTHETIC", amount: 1 })).toEqual({ status: "granted", rewardKey: "web-reward" });
});
