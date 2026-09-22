import { createPromotionAdapter } from "../promotion/adapter.js";
import type { PromotionAdapter, PromotionPlatformLoader, PromotionPlatformSdk } from "../promotion/platform-contract.js";

export interface WebPromotionOptions {
  /** Shared Promotion contract or async loader; defaults to the official SDK. */
  framework?: PromotionPlatformSdk | PromotionPlatformLoader;
  /** Overall wait deadline; 0 (default) disables it. Timeout does not cancel payment. */
  timeoutMs?: number;
}

export function createWebPromotion(options: WebPromotionOptions = {}): PromotionAdapter {
  return createPromotionAdapter(normalizeLoader(options.framework), options.timeoutMs);
}

function normalizeLoader(framework: WebPromotionOptions["framework"]): PromotionPlatformLoader {
  if (typeof framework === "function") return framework;
  if (framework) return async () => ({ available: true, module: framework });
  let cached: PromotionPlatformSdk | undefined;
  return async () => {
    if (cached) return { available: true, module: cached };
    try {
      cached = await import("@apps-in-toss/web-framework");
      return { available: true, module: cached };
    } catch {
      return { available: false, reason: "failed to import @apps-in-toss/web-framework" };
    }
  };
}
