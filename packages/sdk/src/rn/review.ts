import { createReviewAdapter } from "../review/adapter.js";
import type { ReviewAdapter, ReviewPlatformLoader, ReviewPlatformSdk } from "../review/platform-contract.js";
import { adaptOfficialRnReview } from "./official-module.js";

export interface ReactNativeReviewOptions {
  /** Shared contract injection, or a loader; defaults to the lazy official SDK. */
  framework?: ReviewPlatformSdk | ReviewPlatformLoader;
}

export function createReactNativeReview(options: ReactNativeReviewOptions = {}): ReviewAdapter {
  const framework = options.framework;
  return createReviewAdapter(
    typeof framework === "function" ? framework :
      framework ? async () => ({ available: true, module: framework }) : createDefaultReviewLoader()
  );
}

function createDefaultReviewLoader(): ReviewPlatformLoader {
  let cached: ReviewPlatformSdk | undefined;
  return async () => {
    if (cached) return { available: true, module: cached };
    try {
      cached = adaptOfficialRnReview(await import("@apps-in-toss/framework"));
      return { available: true, module: cached };
    } catch {
      // Never cache a failed import or expose SDK error payloads in diagnostics.
      return { available: false, reason: "failed to import @apps-in-toss/framework" };
    }
  };
}
