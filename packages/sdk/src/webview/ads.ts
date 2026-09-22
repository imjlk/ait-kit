import { resolvePlatformLoader } from "../platform-loader.js";
import { createAdsAdapter, type AdsAdapter, type AdsOptions, type AdsPlatformLoader } from "../ads/adapter.js";
import type { FullScreenAdSupport } from "../ads/platform-contract.js";
import { createWebViewPlatformLoader } from "./platform-loader.js";

export type { SdkAdType } from "../ads/adapter.js";
export interface WebViewAdsOptions extends Omit<AdsOptions, "loader"> {
  /** Optional injected framework or loader; the default imports the platform SDK lazily. */
  framework?: AdsPlatformLoader | FullScreenAdSupport;
}
export type WebViewAds = AdsAdapter;

export function createWebViewAds(options: WebViewAdsOptions = {}): WebViewAds {
  return createAdsAdapter({ ...options, loader: resolvePlatformLoader(options.framework, createDefaultAdsLoader) });
}

function createDefaultAdsLoader(): AdsPlatformLoader {
  return createWebViewPlatformLoader(module => {
    if (typeof module.loadFullScreenAd !== "function" || typeof module.showFullScreenAd !== "function") {
      return { available: false, reason: "@apps-in-toss/web-framework does not expose the Ads APIs" };
    }
    return { available: true, module };
  });
}
