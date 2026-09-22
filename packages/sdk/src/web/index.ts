/**
 * Web adapters for `@ait-kit/sdk`.
 *
 * Requires the official `@apps-in-toss/web-framework` package (declared as
 * an optional peer): it is imported lazily at first use, so this entry
 * never requires the React Native SDK, and the React Native entry never
 * requires this one.
 *
 * ```ts
 * import { createWebIap } from "@ait-kit/sdk/web";
 *
 * const iap = createWebIap({
 *   // Resolve only after YOUR server verified the order and persisted the
 *   // grant (see the ait-kit server packages for verification flows).
 *   grant: async ({ orderId, sku }) => {
 *     const response = await fetch("/api/iap/grant", {
 *       method: "POST",
 *       body: JSON.stringify({ orderId, sku })
 *     });
 *     if (!response.ok) {
 *       // Resolve-only-on-success is part of the contract: never report a
 *       // grant your server did not verify and persist.
 *       throw new Error(`grant request failed: HTTP ${response.status}`);
 *     }
 *   }
 * });
 * const result = await iap.purchaseOneTime("SKU_100_COINS");
 * ```
 */
import { createIapAdapter, type IapAdapterOptions, type IapRecoveryResult } from "../iap/adapter.js";
import type { IapPlatformLoader, PartialIapPlatformSdk } from "../iap/platform-contract.js";
import { createDefaultWebFrameworkLoader } from "./framework-loader.js";
import type { WebIapFramework } from "./iap-contract.js";

export interface WebIapOptions extends Omit<IapAdapterOptions, "loader"> {
  /**
   * Web framework injection: pass an `IAP` module instance or a custom
   * loader (tests/consumers). Defaults to the lazy
   * `import("@apps-in-toss/web-framework")` loader.
   */
  framework?: WebIapFramework["IAP"] | PartialIapPlatformSdk | IapPlatformLoader;
}

export type WebIap = ReturnType<typeof createWebIap>;
export type { IapRecoveryResult };

export {
  createWebIdentity,
  type WebIdentity,
  type WebIdentityOptions
} from "./identity.js";
export { createWebStorage, type WebStorageOptions } from "./identity.js";
// createWebStorage lives in identity.ts alongside the shared web loader helpers.

export {
  createWebNotification,
  createWebShare,
  type WebNotification,
  type WebNotificationOptions,
  type WebShare,
  type WebShareOptions
} from "./notify-share.js";

export function createWebIap(options: WebIapOptions) {
  const loader: IapPlatformLoader = !options.framework
    ? createDefaultWebFrameworkLoader()
    : typeof options.framework === "function"
      ? options.framework
      : async () => ({ available: true, module: options.framework as PartialIapPlatformSdk });
  return createIapAdapter({ ...options, loader });
}

export { createWebReview, type WebReviewOptions } from "./review.js";

export { createWebPromotion, type WebPromotionOptions } from "./promotion.js";
