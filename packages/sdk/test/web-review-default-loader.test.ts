import { expect, mock, test } from "bun:test";
import { createWebViewReview } from "../src/webview/review.js";

import { createWebViewPromotion } from "../src/webview/promotion.js";

import { createWebViewAds } from "../src/webview/ads.js";
import type { FullScreenAdSupport } from "../src/webview";

let calls = 0;
let adCleanups = 0;
const loadFullScreenAd = Object.assign((params: Parameters<FullScreenAdSupport["loadFullScreenAd"]>[0]) => {
  params.onEvent({ type: "loaded" });
  return () => { adCleanups++; };
}, { isSupported: () => true });
const showFullScreenAd = Object.assign((params: Parameters<FullScreenAdSupport["showFullScreenAd"]>[0]) => {
  params.onEvent({ type: "userEarnedReward", data: { unitType: "COIN", unitAmount: 3 } });
  params.onEvent({ type: "dismissed" });
  return () => { adCleanups++; };
}, { isSupported: () => true });
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
mock.module("@apps-in-toss/web-framework", () => ({ Review, Promotion, loadFullScreenAd, showFullScreenAd }));

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

test("WebView ads default loader selects flat exports and cleans both registrations", async () => {
  const ads = createWebViewAds();
  await ads.loadFullScreenAd("group");
  expect(await ads.showFullScreenAd("group")).toEqual({ status: "rewarded", reward: { unitType: "COIN", unitAmount: 3 } });
  expect(adCleanups).toBe(2);
});
