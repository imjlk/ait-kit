import { resolvePlatformLoader } from "../platform-loader.js";
import { createWebPlatformLoader } from "./platform-loader.js";
import { createPromotionAdapter } from "../promotion/adapter.js";
import type { PromotionAdapter, PromotionPlatformLoader, PromotionPlatformSdk } from "../promotion/platform-contract.js";

export interface WebPromotionOptions {
  /** Shared Promotion contract or async loader; defaults to the official SDK. */
  framework?: PromotionPlatformSdk | PromotionPlatformLoader;
  /** Overall wait deadline; 0 (default) disables it. Timeout does not cancel payment. */
  timeoutMs?: number;
}

export function createWebPromotion(options: WebPromotionOptions = {}): PromotionAdapter {
  return createPromotionAdapter(resolvePlatformLoader(options.framework, createDefaultPromotionLoader), options.timeoutMs);
}

/** Keep import diagnostics redacted for direct-promotion operations. */
function createDefaultPromotionLoader(): PromotionPlatformLoader {
  return createWebPlatformLoader(module => ({ available: true, module: module }), false);
}
