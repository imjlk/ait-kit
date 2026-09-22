import { expect, mock, test } from "bun:test";
import { createWebReview } from "../src/web/review.js";

let calls = 0;
const request = Object.assign(function(this: unknown) {
  expect(this).toBe(Review);
  calls++;
  return Promise.resolve();
}, { isSupported() { expect(this).toBe(request); return true; } });
const Review = { request };
mock.module("@apps-in-toss/web-framework", () => ({ Review }));

test("Web default loader calls the official object API", async () => {
  const review = createWebReview();
  expect(await review.isSupported()).toBe(true);
  await expect(review.request()).resolves.toBeUndefined();
  expect(calls).toBe(1);
});
