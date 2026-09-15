import {
  SdkError,
  type IapGrantCallback,
  type IapOneTimePurchaseParams,
  type IapProduct,
  type IapSubscriptionPurchaseParams
} from "../index.js";
import type {
  IapPendingOrder,
  IapPurchaseResult
} from "../index.js";
import { IapGrantCoordinator } from "./grant-coordinator.js";
import { type IapPlatformLoader, type PartialIapPlatformSdk } from "./platform-contract.js";
import { runPurchaseFlow } from "./purchase-flow.js";

export interface IapAdapterOptions {
  grant: IapGrantCallback;
  /** Loader for the platform SDK module (already normalized per entry point). */
  loader: IapPlatformLoader;
  /** Overall deadline per purchase flow (default 180000ms; 0 disables). */
  purchaseTimeoutMs?: number;
}

export interface IapRecoveryResult {
  status: "completed" | "grant_failed" | "notify_failed";
  orderId: string;
  reason?: string;
}

export interface IapAdapter {
  /** Lists purchasable products (one-time and subscription together). */
  getProductItemList(): Promise<{ products: IapProduct[] }>;
  /**
   * Starts a one-time purchase. Resolves `completed` only after the
   * platform success event AND your grant callback confirmed the same
   * order.
   */
  purchaseOneTime(sku: string): Promise<IapPurchaseResult>;
  /** Starts a subscription purchase (optionally with a chosen offer). */
  purchaseSubscription(sku: string, offerId?: string): Promise<IapPurchaseResult>;
  /** Lists orders whose payment completed but whose grant was not finished. */
  getPendingOrders(): Promise<{ orders: IapPendingOrder[] }>;
  /**
   * Recovers one pending order: runs (or reuses) the server grant for the
   * order first, and only after it confirms calls the platform's
   * grant-completion notification. Never invoked automatically — the
   * consumer drives recovery.
   */
  recoverPendingOrder(order: IapPendingOrder): Promise<IapRecoveryResult>;
}

const DEFAULT_PURCHASE_TIMEOUT_MS = 180_000;

/**
 * Platform-neutral IAP adapter used by both entry points. The consumer's
 * `grant` callback is the only place product delivery happens; the adapter
 * contains no backend URLs, auth, or persistence.
 */
export function createIapAdapter(options: IapAdapterOptions): IapAdapter {
  const purchaseTimeoutMs = options.purchaseTimeoutMs ?? DEFAULT_PURCHASE_TIMEOUT_MS;
  const coordinator = new IapGrantCoordinator(options.grant);

  const load = async (): Promise<PartialIapPlatformSdk> => {
    const result = await options.loader();
    if (!result.available) {
      throw new SdkError("SDK_UNAVAILABLE", result.reason);
    }
    return result.module;
  };

  /**
   * Per-operation capability gate: an installed framework may expose some
   * IAP functions but not others, so a missing function is UNSUPPORTED only
   * when that specific operation is requested — never a blanket rejection.
   */
  const ensureOperation = <F extends (args: never) => unknown>(fn: F | undefined, label: string): F => {
    if (typeof fn !== "function") {
      throw new SdkError("UNSUPPORTED", `the installed IAP SDK does not expose ${label}`);
    }
    const supported = fn as { isSupported?: () => boolean };
    if (typeof supported.isSupported === "function" && !supported.isSupported()) {
      throw new SdkError("UNSUPPORTED", `${label} is not supported on this app version`);
    }
    return fn;
  };

  return {
    async getProductItemList() {
      const platform = await load();
      ensureOperation(platform.getProductItemList, "getProductItemList");
      // Called as a member so class-instance modules keep their receiver.
      return platform.getProductItemList!();
    },

    purchaseOneTime(sku: string) {
      return purchaseWithDeadline(async (platform, remainingMs) => {
        ensureOperation(platform.createOneTimePurchaseOrder, "one-time purchases");
        return await runPurchaseFlow({
          startOrder: (params: IapOneTimePurchaseParams) =>
            platform.createOneTimePurchaseOrder!(params),
          coordinator,
          sku,
          subscription: false,
          timeoutMs: remainingMs
        });
      });
    },

    purchaseSubscription(sku: string, offerId?: string) {
      return purchaseWithDeadline(async (platform, remainingMs) => {
        ensureOperation(platform.createSubscriptionPurchaseOrder, "subscription purchases");
        return await runPurchaseFlow({
          startOrder: (params: IapSubscriptionPurchaseParams) =>
            platform.createSubscriptionPurchaseOrder!(params),
          coordinator,
          sku,
          ...(offerId !== undefined ? { offerId } : {}),
          subscription: true,
          timeoutMs: remainingMs
        });
      });
    },

    async getPendingOrders() {
      const platform = await load();
      ensureOperation(platform.getPendingOrders, "getPendingOrders");
      return platform.getPendingOrders!();
    },

    async recoverPendingOrder(order: IapPendingOrder): Promise<IapRecoveryResult> {
      const platform = await load();
      ensureOperation(platform.completeProductGrant, "completeProductGrant");
      try {
        // Server grant confirmation first (deduped within this adapter's
        // scope); the completion notification follows only after it.
        await coordinator.run({ orderId: order.orderId, sku: order.sku });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { status: "grant_failed", orderId: order.orderId, reason };
      }
      const notified = await notifyGrantComplete(platform, order.orderId);
      if (!notified.ok) {
        return {
          status: "notify_failed",
          orderId: order.orderId,
          reason: notified.reason
        };
      }
      return { status: "completed", orderId: order.orderId };
    }
  };

  /**
   * Runs a purchase under one overall deadline that also covers platform
   * loading. Only the loading phase races the outer deadline — the purchase
   * flow owns the remaining budget exclusively, so its order-aware timeout
   * result is never preempted by a generic one. A stalled loader cannot
   * wedge checkout, and a loader resolving after the deadline never
   * registers the purchase.
   */
  async function purchaseWithDeadline(
    run: (platform: PartialIapPlatformSdk, remainingMs: number) => Promise<IapPurchaseResult>
  ): Promise<IapPurchaseResult> {
    const timedOut = (): IapPurchaseResult => ({
      status: "unknown",
      reason:
        "purchase flow timed out; the server grant may still be in progress — verify the order server-side and recover it via pending orders"
    });
    if (!(purchaseTimeoutMs > 0)) {
      return run(await load(), 0);
    }
    const startedAt = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loadDeadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        cancelled = true;
        resolve(null);
      }, purchaseTimeoutMs);
    });
    let platform: PartialIapPlatformSdk | null;
    try {
      platform = await Promise.race([
        load().then((loaded) => (cancelled ? null : loaded)),
        loadDeadline
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!platform || cancelled || Date.now() - startedAt >= purchaseTimeoutMs) {
      // The loader may resolve as an overdue microtask before the timer
      // callback runs; a fresh clock comparison is authoritative.
      return timedOut();
    }
    const remainingMs = Math.max(1, purchaseTimeoutMs - (Date.now() - startedAt));
    const result = await run(platform, remainingMs);
    if (Date.now() - startedAt >= purchaseTimeoutMs) {
      // A synchronous startOrder can block past the deadline and settle the
      // flow before the overdue timer callback runs. The deadline is the
      // deadline: preserve any order identity the result already carries
      // for server-side recovery.
      const identified = result as { orderId?: string; subscriptionId?: string };
      return {
        ...timedOut(),
        ...(identified.orderId !== undefined ? { orderId: identified.orderId } : {}),
        ...(identified.subscriptionId !== undefined
          ? { subscriptionId: identified.subscriptionId }
          : {})
      };
    }
    return result;
  }
}

async function notifyGrantComplete(
  platform: PartialIapPlatformSdk,
  orderId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let notified: boolean;
  try {
    notified = await platform.completeProductGrant!({ params: { orderId } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: `completeProductGrant rejected: ${reason}; retry — the server grant is already confirmed in this scope`
    };
  }
  if (!notified) {
    return {
      ok: false,
      reason:
        "completeProductGrant returned false; retry — the server grant is already confirmed in this scope"
    };
  }
  return { ok: true };
}
