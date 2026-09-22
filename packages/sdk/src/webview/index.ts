import { resolvePlatformLoader } from "../platform-loader.js";
/**
 * WebView adapters for `@ait-kit/sdk`.
 *
 * Requires the official `@apps-in-toss/web-framework` package (declared as
 * an optional peer): it is imported lazily at first use, so this entry
 * never requires the React Native SDK, and the React Native entry never
 * requires this one.
 *
 * ```ts
 * import { createWebViewIap } from "@ait-kit/sdk/webview";
 *
 * const iap = createWebViewIap({
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
import { createDefaultWebViewFrameworkLoader } from "./framework-loader.js";
import type { WebViewIapFramework } from "./iap-contract.js";

export interface WebViewIapOptions extends Omit<IapAdapterOptions, "loader" | "orderHistoryPagination"> {
  /**
   * WebView framework injection: pass an `IAP` module instance or a custom
   * loader (tests/consumers). Defaults to the lazy
   * `import("@apps-in-toss/web-framework")` loader.
   */
  framework?: WebViewIapFramework["IAP"] | PartialIapPlatformSdk | IapPlatformLoader;
}

export type WebViewIap = ReturnType<typeof createWebViewIap>;
export type { IapRecoveryResult };

export {
  createWebViewIdentity,
  type WebViewIdentity,
  type WebViewIdentityOptions
} from "./identity.js";
export { createWebViewStorage, type WebViewStorageOptions } from "./identity.js";
// createWebViewStorage lives in identity.ts alongside the shared web loader helpers.

export {
  createWebViewNotification,
  createWebViewShare,
  type WebViewNotification,
  type WebViewNotificationOptions,
  type WebViewShare,
  type WebViewShareOptions
} from "./notify-share.js";

export function createWebViewIap(options: WebViewIapOptions) {
  const loader = resolvePlatformLoader(options.framework, createDefaultWebViewFrameworkLoader);
  return createIapAdapter({ ...options, loader, orderHistoryPagination: "first_page_only" });
}

export { createWebViewReview, type WebViewReviewOptions } from "./review.js";

export { createWebViewPromotion, type WebViewPromotionOptions } from "./promotion.js";

/** @deprecated Use createWebViewIap from @ait-kit/sdk/webview. */
export const createWebIap = createWebViewIap;
/** @deprecated Use WebViewIap from @ait-kit/sdk/webview. */
export type WebIap = WebViewIap;
/** @deprecated Use WebViewIapOptions from @ait-kit/sdk/webview. */
export type WebIapOptions = WebViewIapOptions;

// Compatibility exports for consumers migrating from the /web entry.
export { createWebIdentity, createWebStorage, type WebIdentity, type WebIdentityOptions, type WebStorageOptions } from "./identity.js";
export { createWebNotification, createWebShare, type WebNotification, type WebNotificationOptions, type WebShare, type WebShareOptions } from "./notify-share.js";
export { createWebReview, type WebReviewOptions } from "./review.js";
export { createWebPromotion, type WebPromotionOptions } from "./promotion.js";

export { createWebViewAds, type WebViewAds, type WebViewAdsOptions, type SdkAdType } from "./ads.js";
export type { LoadFullScreenAdParams, FullScreenAdShowEvent, ShowFullScreenAdParams, FullScreenAdFunctions, FullScreenAdSupport } from "../ads/platform-contract.js";

export { createWebViewBannerAds, type WebViewBannerAds, type WebViewBannerAdsOptions, type WebViewBannerHandle, type WebViewBannerOptions, type WebViewBannerCallbacks, type WebViewBannerEvent, type WebViewBannerError, type WebViewBannerPlatform } from "./banner.js";
