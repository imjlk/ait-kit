import { resolvePlatformLoader } from "../platform-loader.js";
import { createAdsAdapter, type AdsAdapter, type AdsOptions, type AdsPlatformLoader } from "../ads/adapter.js";
import type { FullScreenAdSupport } from "../ads/platform-contract.js";
import { createDefaultFrameworkLoader } from "./framework-loader.js";

export type { SdkAdType } from "../ads/adapter.js";
export interface ReactNativeAdsOptions extends Omit<AdsOptions, "loader"> {
  /** Optional injected framework or loader; the default imports the platform SDK lazily. */
  framework?: AdsPlatformLoader | FullScreenAdSupport;
}
export type ReactNativeAds = AdsAdapter;

export function createReactNativeAds(options: ReactNativeAdsOptions = {}): ReactNativeAds {
  return createAdsAdapter({ ...options, loader: resolvePlatformLoader(options.framework, createDefaultFrameworkLoader) });
}
