import { createPromotionAdapter } from "../promotion/adapter.js";
import type { PromotionAdapter, PromotionPlatformLoader, PromotionPlatformSdk } from "../promotion/platform-contract.js";
import { adaptOfficialRnPromotion } from "./official-module.js";

export interface ReactNativePromotionOptions {
  /** Shared Promotion contract or async loader; defaults to the official SDK. */
  framework?: PromotionPlatformSdk | PromotionPlatformLoader;
  /** Overall wait deadline; 0 (default) disables it. Timeout does not cancel payment. */
  timeoutMs?: number;
}

export function createReactNativePromotion(options: ReactNativePromotionOptions = {}): PromotionAdapter {
  return createPromotionAdapter(normalizeLoader(options.framework), options.timeoutMs);
}

function normalizeLoader(framework: ReactNativePromotionOptions["framework"]): PromotionPlatformLoader {
  if (typeof framework === "function") return framework;
  if (framework) return async () => ({ available: true, module: framework });
  let cached: PromotionPlatformSdk | undefined;
  return async () => {
    if (cached) return { available: true, module: cached };
    try {
      cached = adaptOfficialRnPromotion(await import("@apps-in-toss/framework"));
      return { available: true, module: cached };
    } catch {
      return { available: false, reason: "failed to import @apps-in-toss/framework" };
    }
  };
}
