import { createRnPlatformLoader } from "./platform-loader.js";
import type { FullScreenAdSupport } from "./framework-contract.js";

/**
 * Result of trying to load the official framework module. The boolean shape
 * (instead of thrown errors) keeps call sites explicit about the "module
 * missing" case, which is an expected condition for optional peers.
 */
export type FrameworkLoadResult =
  | { available: true; module: FullScreenAdSupport }
  | { available: false; reason: string };

export type FrameworkLoader = () => Promise<FrameworkLoadResult>;

/**
 * Default lazy loader: imports `@apps-in-toss/framework` only when an ad
 * operation needs it. A failed import is never cached, so a later call
 * retries (the module may appear after an update or late bundle load);
 * successful loads are cached.
 */
export function createDefaultFrameworkLoader(): FrameworkLoader {
  return createRnPlatformLoader((module) => {
    if (typeof module.loadFullScreenAd !== "function" || typeof module.showFullScreenAd !== "function") {
      return { available: false, reason: "@apps-in-toss/framework does not expose the Ads APIs" };
    }
    return { available: true, module: module as FullScreenAdSupport };
  });
}
