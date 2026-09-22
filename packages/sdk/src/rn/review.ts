import { resolvePlatformLoader } from "../platform-loader.js";
import { createRnPlatformLoader } from "./platform-loader.js";
import { createReviewAdapter } from "../review/adapter.js";
import type { ReviewAdapter, ReviewPlatformLoader, ReviewPlatformSdk } from "../review/platform-contract.js";
import { adaptOfficialRnReview } from "./official-module.js";

export interface ReactNativeReviewOptions {
  /** Shared contract injection, or a loader; defaults to the lazy official SDK. */
  framework?: ReviewPlatformSdk | ReviewPlatformLoader;
}

export function createReactNativeReview(options: ReactNativeReviewOptions = {}): ReviewAdapter {
  return createReviewAdapter(resolvePlatformLoader(options.framework, createDefaultReviewLoader));
}

function createDefaultReviewLoader(): ReviewPlatformLoader {
  return createRnPlatformLoader(module => ({ available: true, module: adaptOfficialRnReview(module) }), false);
}
