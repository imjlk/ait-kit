import { createWebViewPlatformLoader } from "./platform-loader.js";
import type { IapPlatformLoader } from "../iap/platform-contract.js";

/**
 * Default lazy loader for the official web SDK: imports
 * `@apps-in-toss/web-framework` (an optional peer) only when an IAP
 * operation needs it. Failed imports are never cached, so a later call
 * retries; successful loads are cached.
 */
export function createDefaultWebViewFrameworkLoader(): IapPlatformLoader {
  return createWebViewPlatformLoader((framework) => {
    const iap = framework.IAP;
    if (typeof iap !== "object" || iap === null) {
      return { available: false, reason: "@apps-in-toss/web-framework does not expose an IAP domain" };
    }
    return { available: true, module: iap };
  });
}
