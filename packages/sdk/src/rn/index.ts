/**
 * React Native adapters for `@ait-kit/sdk`.
 *
 * Requires the official `@apps-in-toss/framework` package (declared as an
 * optional peer): it is imported lazily at first use, so plain Node bundles
 * of the root entry never touch React Native code.
 *
 * ```ts
 * import { createReactNativeAds } from "@ait-kit/sdk/rn";
 *
 * const ads = createReactNativeAds();
 * await ads.loadFullScreenAd("AD_GROUP_ID");
 * const result = await ads.showFullScreenAd("AD_GROUP_ID");
 * if (result.status === "rewarded") {
 *   // Verify the reward against your server before crediting anything.
 * }
 * ```
 */
export {
  createReactNativeAds,
  type ReactNativeAds,
  type ReactNativeAdsOptions,
  type SdkAdType
} from "./ads.js";
export {
  createReactNativeIap,
  type ReactNativeIap,
  type ReactNativeIapOptions
} from "./iap.js";
export type { IapRecoveryResult } from "./iap.js";
export {
  createReactNativeIdentity,
  type ReactNativeIdentity,
  type ReactNativeIdentityOptions
} from "./identity.js";
export {
  createReactNativeStorage,
  type ReactNativeStorageOptions
} from "./storage.js";
export {
  createReactNativeNotification,
  createReactNativeShare,
  type ReactNativeNotification,
  type ReactNativeNotificationOptions,
  type ReactNativeShare,
  type ReactNativeShareOptions
} from "./notify-share.js";
export { createDefaultFrameworkLoader, type FrameworkLoader } from "./framework-loader.js";
export type {
  FullScreenAdShowEvent,
  FullScreenAdSupport,
  LoadFullScreenAdParams,
  ShowFullScreenAdParams
} from "./framework-contract.js";

export { createReactNativeReview, type ReactNativeReviewOptions } from "./review.js";
