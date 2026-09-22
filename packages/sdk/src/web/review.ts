import { createReviewAdapter } from "../review/adapter.js";
import type { ReviewAdapter, ReviewPlatformLoader, ReviewPlatformSdk } from "../review/platform-contract.js";

export interface WebReviewOptions {
  /** Shared contract injection, or a loader; defaults to the lazy official SDK. */
  framework?: ReviewPlatformSdk | ReviewPlatformLoader;
}

export function createWebReview(options: WebReviewOptions = {}): ReviewAdapter {
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
      cached = await import("@apps-in-toss/web-framework");
      return { available: true, module: cached };
    } catch {
      // Never cache a failed import or expose SDK error payloads in diagnostics.
      return { available: false, reason: "failed to import @apps-in-toss/web-framework" };
    }
  };
}
