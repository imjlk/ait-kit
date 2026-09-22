import { describe, expect, test } from "bun:test";
import { createReactNativeIap } from "../src/rn";
import { createWebViewIap } from "../src/webview";
import type { IapCompletedOrRefundedOrder } from "../src";
const orders: IapCompletedOrRefundedOrder[] = [{ orderId: "o", sku: "sku", status: "COMPLETED", date: "2026-09-22" }, { orderId: "r", sku: "sku", status: "REFUNDED", date: "2026-09-22" }];
for (const [create, pagination] of [[createReactNativeIap, "cursor"], [createWebViewIap, "first_page_only"]] as const) {
  describe(create.name + " order history", () => {
    test("returns provider page and paging limits without running grants", async () => {
      let grants = 0;
      const framework = { async getCompletedOrRefundedOrders(...args: unknown[]) {
        expect(this).toBe(framework);
        expect(args).toEqual([]);
        return { orders, hasNext: true, nextKey: "next" };
      } };
      const page = await create({ framework, grant: async () => { grants++; } }).getCompletedOrRefundedOrders();
      expect(page).toEqual({ orders, hasNext: true, nextKey: "next", pagination });
      expect(page.orders).not.toBe(orders);
      expect(page.orders[0]).not.toBe(orders[0]);
      expect(grants).toBe(0);
    });
    test("gates missing functions and unsupported provider signals", async () => {
      for (const framework of [{}, { getCompletedOrRefundedOrders: Object.assign(async () => { throw new Error("do not call"); }, { isSupported: () => false }) }, { getCompletedOrRefundedOrders: async () => undefined }, { getCompletedOrRefundedOrders: async () => { throw { code: "UNSUPPORTED_APP_VERSION" }; } }]) {
        await expect(create({ framework, grant: async () => {} }).getCompletedOrRefundedOrders()).rejects.toMatchObject({ code: "UNSUPPORTED" });
      }
    });
    test("rejects malformed pages without rewriting refund status", async () => {
      for (const value of [null, {}, { orders: [], hasNext: 1 }, { orders: [{ ...orders[0], status: "FUTURE" }], hasNext: false }, { orders, hasNext: true, nextKey: 123 }]) {
        await expect(create({ framework: { getCompletedOrRefundedOrders: async () => value }, grant: async () => {} }).getCompletedOrRefundedOrders()).rejects.toMatchObject({ code: "INVALID_IAP_RESULT" });
      }
    });
  });
}
test("RN forwards an opaque cursor with the official top-level key shape", async () => {
  const seen: unknown[] = [];
  const iap = createReactNativeIap({ framework: { getCompletedOrRefundedOrders: async args => { seen.push(args); return { orders: [], hasNext: false, nextKey: null }; } }, grant: async () => {} });
  expect((await iap.getCompletedOrRefundedOrders({ key: "opaque" })).pagination).toBe("cursor");
  expect(seen).toEqual([{ key: "opaque" }]);
});
test("WebView rejects later pages before acquiring the SDK and never retries page one", async () => {
  let loads = 0;
  const iap = createWebViewIap({ framework: async () => { loads++; return { available: true, module: {} }; }, grant: async () => {} });
  await expect(iap.getCompletedOrRefundedOrders({ key: "next" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
  await expect(iap.getCompletedOrRefundedOrders({ key: "" })).rejects.toMatchObject({ code: "INVALID_IAP_INPUT" });
  expect(loads).toBe(0);
});
test("provider errors propagate without automatic replay", async () => {
  const error = new Error("network");
  let calls = 0;
  const iap = createReactNativeIap({ framework: { getCompletedOrRefundedOrders: async () => { calls++; throw error; } }, grant: async () => {} });
  await expect(iap.getCompletedOrRefundedOrders()).rejects.toBe(error);
  expect(calls).toBe(1);
});
