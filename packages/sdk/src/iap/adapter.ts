import { SdkError, type IapGrantCallback, type IapProduct } from "../index.js";
import type {
  IapPendingOrder,
  IapPurchaseResult
} from "../index.js";
import { IapGrantCoordinator } from "./grant-coordinator.js";
import { type IapPlatformLoader, type IapPlatformSdk } from "./platform-contract.js";
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

  const load = async (): Promise<IapPlatformSdk> => {
    const result = await options.loader();
    if (!result.available) {
      throw new SdkError("SDK_UNAVAILABLE", result.reason);
    }
    return result.module;
  };

  const ensureSupported = (fn: { isSupported?: () => boolean }, label: string) => {
    if (typeof fn.isSupported === "function" && !fn.isSupported()) {
      throw new SdkError("UNSUPPORTED", `${label} is not supported on this app version`);
    }
  };

  return {
    async getProductItemList() {
      const platform = await load();
      ensureSupported(platform.getProductItemList, "getProductItemList");
      return platform.getProductItemList();
    },

    purchaseOneTime(sku: string) {
      return (async () => {
        const platform = await load();
        ensureSupported(platform.createOneTimePurchaseOrder, "one-time purchases");
        return await runPurchaseFlow({
          platform,
          coordinator,
          sku,
          subscription: false,
          timeoutMs: purchaseTimeoutMs
        });
      })();
    },

    purchaseSubscription(sku: string, offerId?: string) {
      return (async () => {
        const platform = await load();
        ensureSupported(platform.createSubscriptionPurchaseOrder, "subscription purchases");
        return await runPurchaseFlow({
          platform,
          coordinator,
          sku,
          ...(offerId !== undefined ? { offerId } : {}),
          subscription: true,
          timeoutMs: purchaseTimeoutMs
        });
      })();
    },

    async getPendingOrders() {
      const platform = await load();
      ensureSupported(platform.getPendingOrders, "getPendingOrders");
      return platform.getPendingOrders();
    },

    async recoverPendingOrder(order: IapPendingOrder): Promise<IapRecoveryResult> {
      const platform = await load();
      ensureSupported(platform.completeProductGrant, "completeProductGrant");
      try {
        // Server grant confirmation first (deduped within this adapter's
        // scope); the completion notification follows only after it.
        await coordinator.run({ orderId: order.orderId, sku: order.sku });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { status: "grant_failed", orderId: order.orderId, reason };
      }
      const notified = await platform.completeProductGrant({
        params: { orderId: order.orderId }
      });
      if (!notified) {
        return {
          status: "notify_failed",
          orderId: order.orderId,
          reason: "completeProductGrant returned false; retry — the server grant is already confirmed in this scope"
        };
      }
      return { status: "completed", orderId: order.orderId };
    }
  };
}
