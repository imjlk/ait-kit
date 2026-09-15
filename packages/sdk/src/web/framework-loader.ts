import type { IapPlatformLoader } from "../iap/platform-contract.js";
import type { WebIapFramework } from "./iap-contract.js";

/**
 * Default lazy loader for the official web SDK: imports
 * `@apps-in-toss/web-framework` (an optional peer) only when an IAP
 * operation needs it. Failed imports are never cached, so a later call
 * retries; successful loads are cached.
 */
export function createDefaultWebFrameworkLoader(): IapPlatformLoader {
  let cached: WebIapFramework["IAP"] | undefined;
  return async () => {
    if (cached) {
      return { available: true, module: cached };
    }
    try {
      const framework = (await import("@apps-in-toss/web-framework")) as Partial<WebIapFramework>;
      const iap = framework.IAP;
      if (
        !iap ||
        typeof iap.getProductItemList !== "function" ||
        typeof iap.createOneTimePurchaseOrder !== "function" ||
        typeof iap.createSubscriptionPurchaseOrder !== "function" ||
        typeof iap.getPendingOrders !== "function" ||
        typeof iap.completeProductGrant !== "function"
      ) {
        return {
          available: false,
          reason: "@apps-in-toss/web-framework does not expose the IAP APIs"
        };
      }
      cached = iap;
      return { available: true, module: cached };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, reason: `failed to import @apps-in-toss/web-framework: ${message}` };
    }
  };
}
