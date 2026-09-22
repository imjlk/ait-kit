import { resolvePlatformLoader } from "../platform-loader.js";
import { createWebPlatformLoader } from "./platform-loader.js";
import { createReviewAdapter } from "../review/adapter.js";
import type { ReviewAdapter, ReviewPlatformLoader, ReviewPlatformSdk } from "../review/platform-contract.js";

export interface WebReviewOptions {
  /** Shared contract injection, or a loader; defaults to the lazy official SDK. */
  framework?: ReviewPlatformSdk | ReviewPlatformLoader;
}

export function createWebReview(options: WebReviewOptions = {}): ReviewAdapter {
  return createReviewAdapter(resolvePlatformLoader(options.framework, createDefaultReviewLoader));
}

function createDefaultReviewLoader(): ReviewPlatformLoader {
  return createWebPlatformLoader(module => ({ available: true, module: module }), false);
}
