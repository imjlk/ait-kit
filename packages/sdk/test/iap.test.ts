import { describe, expect, test } from "bun:test";
import type {
  IapOneTimePurchaseParams,
  IapPendingOrder,
  IapPurchaseSuccessInfo,
  IapSubscriptionPurchaseParams
} from "../src";
import { createReactNativeIap } from "../src/rn";
import { createWebViewIap } from "../src/webview";
import type { IapPlatformSdk } from "../src/iap/platform-contract";

interface CapturedPurchase {
  kind: "one-time" | "subscription";
  sku: string;
  offerId?: string | null;
  processProductGrant: (params: {
    orderId: string;
    subscriptionId?: string;
  }) => boolean | Promise<boolean>;
  onEvent: (event: { type: "success"; data: IapPurchaseSuccessInfo }) => void;
  onError: (error: unknown) => void;
}

function fakeIapPlatform() {
  const purchases: CapturedPurchase[] = [];
  const completedGrants: string[] = [];
  const platform: IapPlatformSdk = {
    async getProductItemList() {
      return {
        products: [
          {
            sku: "SKU_COINS",
            type: "CONSUMABLE",
            displayName: "Coins",
            displayAmount: "1,000원",
            iconUrl: "https://example.com/icon.png",
            description: "coins"
          }
        ]
      };
    },
    createOneTimePurchaseOrder(params: IapOneTimePurchaseParams) {
      const captured: CapturedPurchase = {
        kind: "one-time",
        sku: params.options.sku,
        processProductGrant: params.options.processProductGrant,
        onEvent: params.onEvent,
        onError: params.onError
      };
      purchases.push(captured);
      return () => {};
    },
    createSubscriptionPurchaseOrder(params: IapSubscriptionPurchaseParams) {
      const captured: CapturedPurchase = {
        kind: "subscription",
        sku: params.options.sku,
        ...(params.options.offerId !== undefined ? { offerId: params.options.offerId } : {}),
        processProductGrant: params.options.processProductGrant,
        onEvent: params.onEvent,
        onError: params.onError
      };
      purchases.push(captured);
      return () => {};
    },
    async getPendingOrders() {
      return { orders: pendingOrders.slice() };
    },
    async completeProductGrant(args: { params: { orderId: string } }) {
      completedGrants.push(args.params.orderId);
      if (completeGrantError) {
        throw completeGrantError;
      }
      return completeGrantResult;
    }
  };
  let pendingOrders: IapPendingOrder[] = [];
  let completeGrantResult = true;
  let completeGrantError: unknown;
  return {
    platform,
    purchases,
    completedGrants,
    setPendingOrders: (orders: IapPendingOrder[]) => {
      pendingOrders = orders;
    },
    setCompleteGrantResult: (value: boolean) => {
      completeGrantResult = value;
    },
    setCompleteGrantError: (error: unknown) => {
      completeGrantError = error;
    }
  };
}

const successPayload = (orderId: string): IapPurchaseSuccessInfo => ({
  orderId,
  displayName: "Coins",
  displayAmount: "1,000원",
  amount: 1000,
  currency: "KRW",
  fraction: 0,
  miniAppIconUrl: null
});

function grantTracker() {
  const calls: Array<{ orderId: string }> = [];
  let mode: "ok" | "fail" = "ok";
  return {
    calls,
    fail: () => {
      mode = "fail";
    },
    succeed: () => {
      mode = "ok";
    },
    callback: async (target: { orderId: string }) => {
      calls.push({ orderId: target.orderId });
      if (mode === "fail") {
        throw new Error("server rejected the grant");
      }
    }
  };
}

describe("@ait-kit/sdk IAP adapters", () => {
  test("completes a purchase when the grant confirms the success event's order", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();
    const iap = createReactNativeIap({ framework: fake.platform, grant: grants.callback });

    const promise = iap.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const captured = fake.purchases[0];

    expect(await captured.processProductGrant({ orderId: "order-1" })).toBe(true);
    captured.onEvent({ type: "success", data: successPayload("order-1") });

    await expect(promise).resolves.toMatchObject({
      status: "completed",
      orderId: "order-1",
      success: { orderId: "order-1", amount: 1000 }
    });
    expect(grants.calls).toEqual([{ orderId: "order-1" }]);
  });

  test("does not complete when the success event arrives before the grant confirms", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();
    const iap = createReactNativeIap({ framework: fake.platform, grant: grants.callback });

    const promise = iap.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const captured = fake.purchases[0];

    // Success event first: the promise must stay pending until the grant
    // for the same order resolves.
    captured.onEvent({ type: "success", data: successPayload("order-1") });
    await Bun.sleep(5);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);

    expect(await captured.processProductGrant({ orderId: "order-1" })).toBe(true);
    await expect(promise).resolves.toMatchObject({ status: "completed", orderId: "order-1" });
  });

  test("rejects cross-order completion with ORDER_MISMATCH", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();
    const iap = createReactNativeIap({ framework: fake.platform, grant: grants.callback });

    const promise = iap.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const captured = fake.purchases[0];

    expect(await captured.processProductGrant({ orderId: "order-A" })).toBe(true);
    captured.onEvent({ type: "success", data: successPayload("order-B") });

    await expect(promise).resolves.toMatchObject({
      status: "failed",
      code: "ORDER_MISMATCH"
    });
  });

  test("fails the purchase when the server grant callback fails", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();
    grants.fail();
    const iap = createReactNativeIap({ framework: fake.platform, grant: grants.callback });

    const promise = iap.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const captured = fake.purchases[0];

    expect(await captured.processProductGrant({ orderId: "order-1" })).toBe(false);

    await expect(promise).resolves.toMatchObject({
      status: "grant_failed",
      orderId: "order-1",
      reason: expect.stringContaining("server rejected the grant")
    });
  });

  test("grant failure wins over a later SDK error and success", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();
    grants.fail();
    const iap = createReactNativeIap({ framework: fake.platform, grant: grants.callback });

    const promise = iap.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const captured = fake.purchases[0];

    expect(await captured.processProductGrant({ orderId: "order-1" })).toBe(false);
    captured.onError({ code: "INTERNAL_ERROR", message: "boom" });
    captured.onEvent({ type: "success", data: successPayload("order-1") });

    await expect(promise).resolves.toMatchObject({ status: "grant_failed", orderId: "order-1" });
  });

  test("maps USER_CANCELED and SDK errors", async () => {
    const fake = fakeIapPlatform();
    const canceled = createReactNativeIap({ framework: fake.platform, grant: async () => {} });
    const canceledPromise = canceled.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    fake.purchases[0].onError({ code: "USER_CANCELED", message: "user left" });
    await expect(canceledPromise).resolves.toEqual({ status: "canceled" });

    const failed = createReactNativeIap({ framework: fake.platform, grant: async () => {} });
    const failedPromise = failed.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    fake.purchases[1].onError({ code: "PAYMENT_PENDING", message: "payment pending" });
    await expect(failedPromise).resolves.toMatchObject({
      status: "failed",
      code: "PAYMENT_PENDING",
      reason: "payment pending"
    });
  });

  test("timeout yields unknown and late events never change the result", async () => {
    const fake = fakeIapPlatform();
    const iap = createReactNativeIap({
      framework: fake.platform,
      grant: async () => {},
      purchaseTimeoutMs: 20
    });

    const promise = iap.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const captured = fake.purchases[0];

    await expect(promise).resolves.toMatchObject({ status: "unknown" });

    // Late grant + success after the terminal timeout must be ignored.
    await captured.processProductGrant({ orderId: "order-1" });
    captured.onEvent({ type: "success", data: successPayload("order-1") });
    await expect(promise).resolves.toMatchObject({ status: "unknown" });
  });

  test("shares one grant call for concurrent duplicate orders and reuses success in scope", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();
    const iap = createReactNativeIap({ framework: fake.platform, grant: grants.callback });

    const first = iap.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const captured = fake.purchases[0];

    // Fire the grant callback twice for the same order before it settles.
    const grantA = captured.processProductGrant({ orderId: "order-1" });
    const grantB = captured.processProductGrant({ orderId: "order-1" });
    expect(await grantA).toBe(true);
    expect(await grantB).toBe(true);
    captured.onEvent({ type: "success", data: successPayload("order-1") });
    await expect(first).resolves.toMatchObject({ status: "completed", orderId: "order-1" });
    // One server call for both concurrent callbacks.
    expect(grants.calls).toEqual([{ orderId: "order-1" }]);

    // A second flow reusing the same order AND target resolves the grant
    // immediately without another server call.
    const second = iap.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const reuse = fake.purchases[1];
    expect(reuse.kind).toBe("one-time");
    expect(await reuse.processProductGrant({ orderId: "order-1" })).toBe(true);
    reuse.onEvent({ type: "success", data: successPayload("order-1") });
    await expect(second).resolves.toMatchObject({
      status: "completed",
      orderId: "order-1"
    });
    expect(grants.calls).toHaveLength(1);
  });

  test("rejects conflicting grant targets for one order", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();
    const iap = createReactNativeIap({ framework: fake.platform, grant: grants.callback });

    // Two flows for DIFFERENT products that both claim order-1.
    const coins = iap.purchaseOneTime("SKU_COINS");
    const gems = iap.purchaseOneTime("SKU_GEMS");
    await Bun.sleep(1);
    const coinsFlow = fake.purchases[0];
    const gemsFlow = fake.purchases[1];

    const legitimate = coinsFlow.processProductGrant({ orderId: "order-1" });
    // Same order, different product: must not inherit the first grant.
    const conflicting = gemsFlow.processProductGrant({ orderId: "order-1" });
    await expect(conflicting).resolves.toBe(false);

    coinsFlow.onEvent({ type: "success", data: successPayload("order-1") });
    // The first flow's grant is the legitimate one and completes normally.
    expect(await legitimate).toBe(true);
    await expect(coins).resolves.toMatchObject({ status: "completed", orderId: "order-1" });
    // The conflicting flow reports a failed grant, not a completed purchase.
    gemsFlow.onError({ code: "PRODUCT_NOT_GRANTED_BY_PARTNER", message: "not granted" });
    await expect(gems).resolves.toMatchObject({ status: "grant_failed", orderId: "order-1" });
    // Only the first, legitimate target reached the server callback.
    expect(grants.calls).toHaveLength(1);
  });

  test("retries the grant after a failure (failures are not cached)", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();

    const first = createReactNativeIap({ framework: fake.platform, grant: grants.callback });
    const failing = first.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    grants.fail();
    await fake.purchases[0].processProductGrant({ orderId: "order-1" });
    await expect(failing).resolves.toMatchObject({ status: "grant_failed" });

    // A new attempt (fresh scope) must re-run the grant and can succeed.
    grants.succeed();
    const second = createReactNativeIap({ framework: fake.platform, grant: grants.callback });
    const promise = second.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const captured = fake.purchases[1];
    expect(await captured.processProductGrant({ orderId: "order-1" })).toBe(true);
    captured.onEvent({ type: "success", data: successPayload("order-1") });
    await expect(promise).resolves.toMatchObject({ status: "completed", orderId: "order-1" });
    expect(grants.calls).toHaveLength(2);
  });

  test("recovers pending orders: server grant first, completion notification second", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();
    const iap = createReactNativeIap({ framework: fake.platform, grant: grants.callback });
    fake.setPendingOrders([
      { orderId: "pending-1", sku: "SKU_COINS", paymentCompletedDate: "2026-01-01T00:00:00Z" }
    ]);

    const { orders } = await iap.getPendingOrders();
    expect(orders).toEqual([
      { orderId: "pending-1", sku: "SKU_COINS", paymentCompletedDate: "2026-01-01T00:00:00Z" }
    ]);

    const result = await iap.recoverPendingOrder(orders[0]);
    expect(result).toEqual({ status: "completed", orderId: "pending-1" });
    // Exactly one server grant, and the completion notification happened
    // strictly after it (recorded orders prove sequence: grant tracker has
    // the order before completedGrants receives it).
    expect(grants.calls).toEqual([{ orderId: "pending-1" }]);
    expect(fake.completedGrants).toEqual(["pending-1"]);

    // Recovering the same order again reuses the grant in this scope and
    // only repeats the (idempotent) notification.
    const again = await iap.recoverPendingOrder(orders[0]);
    expect(again).toEqual({ status: "completed", orderId: "pending-1" });
    expect(grants.calls).toHaveLength(1);
    expect(fake.completedGrants).toEqual(["pending-1", "pending-1"]);
  });

  test("surfaces notify failures without re-running the grant", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();
    const iap = createReactNativeIap({ framework: fake.platform, grant: grants.callback });
    fake.setCompleteGrantResult(false);

    const result = await iap.recoverPendingOrder({
      orderId: "pending-1",
      sku: "SKU_COINS",
      paymentCompletedDate: "2026-01-01T00:00:00Z"
    });

    expect(result).toMatchObject({ status: "notify_failed", orderId: "pending-1" });
    expect(grants.calls).toHaveLength(1);
  });

  test("converts a rejected completion notification to notify_failed", async () => {
    const fake = fakeIapPlatform();
    fake.setCompleteGrantError(new Error("bridge down"));
    const iap = createReactNativeIap({ framework: fake.platform, grant: async () => {} });

    const result = await iap.recoverPendingOrder({
      orderId: "pending-1",
      sku: "SKU_COINS",
      paymentCompletedDate: "2026-01-01T00:00:00Z"
    });

    expect(result).toMatchObject({
      status: "notify_failed",
      orderId: "pending-1",
      reason: expect.stringContaining("bridge down")
    });
  });

  test("bounds the purchase deadline across platform loading", async () => {
    const iap = createReactNativeIap({
      framework: () => new Promise(() => {}), // loader never resolves
      grant: async () => {},
      purchaseTimeoutMs: 20
    });

    await expect(iap.purchaseOneTime("SKU_COINS")).resolves.toMatchObject({
      status: "unknown",
      reason: expect.stringContaining("timed out")
    });
  });

  test("a loader resolving after the deadline never registers the purchase", async () => {
    const fake = fakeIapPlatform();
    let resolveLoader!: (value: { available: true; module: typeof fake.platform }) => void;
    const iap = createReactNativeIap({
      framework: () =>
        new Promise((resolve) => {
          resolveLoader = resolve;
        }),
      grant: async () => {},
      purchaseTimeoutMs: 20
    });

    const promise = iap.purchaseOneTime("SKU_COINS");
    await expect(promise).resolves.toMatchObject({ status: "unknown" });

    // Late resolution must not register a purchase for the expired flow.
    resolveLoader({ available: true, module: fake.platform });
    await Bun.sleep(5);
    expect(fake.purchases).toHaveLength(0);
  });

  test("reports the observed order id when the grant is still pending at timeout", async () => {
    const fake = fakeIapPlatform();
    let releaseGrant!: () => void;
    const iap = createReactNativeIap({
      framework: fake.platform,
      grant: () =>
        new Promise((resolve) => {
          releaseGrant = resolve;
        }),
      purchaseTimeoutMs: 20
    });

    const promise = iap.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const captured = fake.purchases[0];
    void captured.processProductGrant({ orderId: "order-9", subscriptionId: "sub-1" });

    await expect(promise).resolves.toMatchObject({
      status: "unknown",
      orderId: "order-9",
      subscriptionId: "sub-1"
    });
    releaseGrant();
  });

  test("reports unknown when an SDK error follows a confirmed grant", async () => {
    const fake = fakeIapPlatform();
    const iap = createReactNativeIap({ framework: fake.platform, grant: async () => {} });

    const promise = iap.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const captured = fake.purchases[0];

    // Grant confirmed, then the bridge errors before the success event.
    expect(await captured.processProductGrant({ orderId: "order-1" })).toBe(true);
    captured.onError({ code: "INTERNAL_ERROR", message: "bridge failed late" });

    await expect(promise).resolves.toMatchObject({
      status: "unknown",
      orderId: "order-1",
      reason: expect.stringContaining("verify server-side")
    });
  });

  test("does not register a purchase when the loader blocks past the deadline", async () => {
    const fake = fakeIapPlatform();
    const iap = createReactNativeIap({
      framework: async () => {
        // Blocks the event loop past the 20ms deadline, then resolves.
        const start = Date.now();
        while (Date.now() - start < 30) {
          /* spin */
        }
        return { available: true, module: fake.platform };
      },
      grant: async () => {},
      purchaseTimeoutMs: 20
    });

    await expect(iap.purchaseOneTime("SKU_COINS")).resolves.toMatchObject({ status: "unknown" });
    // The overdue load must not have registered a provider purchase.
    expect(fake.purchases).toHaveLength(0);
  });

  test("validates IAP capability per operation, not per module", async () => {
    const fake = fakeIapPlatform();
    // Partial capability surface: subscriptions missing on this version.
    const partial = {
      ...fake.platform,
      createSubscriptionPurchaseOrder: undefined
    } as unknown as typeof fake.platform;
    const iap = createReactNativeIap({ framework: partial, grant: async () => {} });

    const { products } = await iap.getProductItemList();
    expect(products[0].sku).toBe("SKU_COINS");

    await expect(iap.purchaseSubscription("SKU_SUB")).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("subscription purchases")
    });
  });

  test("reports unknown when an SDK error follows a stashed success event", async () => {
    const fake = fakeIapPlatform();
    const iap = createReactNativeIap({ framework: fake.platform, grant: async () => {} });

    const promise = iap.purchaseOneTime("SKU_COINS");
    await Bun.sleep(1);
    const captured = fake.purchases[0];

    // Success event first (parked), then the SDK errors before the grant.
    captured.onEvent({ type: "success", data: successPayload("order-7") });
    captured.onError({ code: "INTERNAL_ERROR", message: "late bridge failure" });

    await expect(promise).resolves.toMatchObject({
      status: "unknown",
      orderId: "order-7",
      reason: expect.stringContaining("verify server-side")
    });
  });

  test("recovery joins a subscription grant without knowing the subscription id", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();
    const iap = createReactNativeIap({ framework: fake.platform, grant: grants.callback });

    // A subscription purchase grant confirms (and caches) with subscriptionId.
    const purchase = iap.purchaseSubscription("SKU_SUB");
    await Bun.sleep(1);
    const captured = fake.purchases[0];
    expect(await captured.processProductGrant({ orderId: "order-5", subscriptionId: "sub-5" })).toBe(true);
    captured.onEvent({ type: "success", data: successPayload("order-5") });
    await expect(purchase).resolves.toMatchObject({ status: "completed", orderId: "order-5" });

    // Pending-order recovery knows only orderId + sku; it must join the
    // cached grant instead of conflicting with it.
    fake.setPendingOrders([
      { orderId: "order-5", sku: "SKU_SUB", paymentCompletedDate: "2026-01-01T00:00:00Z" }
    ]);
    const { orders } = await iap.getPendingOrders();
    const result = await iap.recoverPendingOrder(orders[0]);
    expect(result).toEqual({ status: "completed", orderId: "order-5" });
    expect(grants.calls).toHaveLength(1);
  });

  test("a cached grant without a subscriptionId never satisfies an explicit one", async () => {
    const fake = fakeIapPlatform();
    const grants = grantTracker();
    const iap = createReactNativeIap({ framework: fake.platform, grant: grants.callback });

    // Recovery first: caches { orderId, sku } without a subscriptionId.
    const recovered = await iap.recoverPendingOrder({
      orderId: "order-5",
      sku: "SKU_SUB",
      paymentCompletedDate: "2026-01-01T00:00:00Z"
    });
    expect(recovered.status).toBe("completed");

    // A later subscription purchase claiming the same order with an
    // explicit subscriptionId must not inherit that grant.
    const purchase = iap.purchaseSubscription("SKU_SUB");
    await Bun.sleep(1);
    const captured = fake.purchases[0];
    await expect(captured.processProductGrant({ orderId: "order-5", subscriptionId: "sub-A" })).resolves.toBe(false);
    captured.onError({ code: "PRODUCT_NOT_GRANTED_BY_PARTNER", message: "not granted" });
    await expect(purchase).resolves.toMatchObject({
      status: "grant_failed",
      orderId: "order-5"
    });
    // Only the recovery's grant reached the server.
    expect(grants.calls).toHaveLength(1);
  });

  test("does not report completion when startOrder blocks past the deadline", async () => {
    const blocking = fakeIapPlatform();
    (blocking.platform as { createOneTimePurchaseOrder: unknown }).createOneTimePurchaseOrder = (
      params: IapOneTimePurchaseParams
    ) => {
      const start = Date.now();
      while (Date.now() - start < 30) {
        /* block past the 20ms deadline */
      }
      // Resolves everything synchronously while the timer callback still
      // has not run.
      void Promise.resolve().then(async () => {
        const granted = await params.options.processProductGrant({ orderId: "order-1" });
        if (granted) {
          params.onEvent({ type: "success", data: successPayload("order-1") });
        } else {
          params.onError({ code: "INTERNAL_ERROR", message: "grant failed" });
        }
      });
      return () => {};
    };
    const iap = createReactNativeIap({
      framework: blocking.platform,
      grant: async () => {},
      purchaseTimeoutMs: 20
    });

    await expect(iap.purchaseOneTime("SKU_COINS")).resolves.toMatchObject({
      status: "unknown",
      orderId: "order-1"
    });
  });

  test("calls injected class-instance modules with their receiver", async () => {
    class InstanceIap {
      async getProductItemList() {
        return { products: [{ sku: this.secret, type: "CONSUMABLE", displayName: "x", displayAmount: "1", iconUrl: "i", description: "d" }] };
      }
      secret = "FROM_THIS";
    }
    const iap = createReactNativeIap({
      framework: new InstanceIap() as unknown as Parameters<typeof createReactNativeIap>[0]["framework"],
      grant: async () => {}
    });

    const { products } = await iap.getProductItemList();
    expect(products[0].sku).toBe("FROM_THIS");
  });

  test("lists products and reports unsupported operations", async () => {
    const fake = fakeIapPlatform();
    (fake.platform.getProductItemList as { isSupported?: () => boolean }).isSupported = () => false;
    const iap = createReactNativeIap({ framework: fake.platform, grant: async () => {} });

    await expect(iap.getProductItemList()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  test("web adapter rejects with SDK_UNAVAILABLE when the web SDK is missing", async () => {
    const web = createWebViewIap({
      framework: async () => ({ available: false, reason: "web sdk not installed" }),
      grant: async () => {}
    });

    await expect(web.purchaseOneTime("SKU_COINS")).rejects.toMatchObject({
      code: "SDK_UNAVAILABLE",
      message: "web sdk not installed"
    });
  });

  test("web adapter works with an injected module", async () => {
    const fake = fakeIapPlatform();
    const web = createWebViewIap({ framework: fake.platform, grant: async () => {} });

    const { products } = await web.getProductItemList();
    expect(products[0]).toMatchObject({ sku: "SKU_COINS", type: "CONSUMABLE" });
  });
});
