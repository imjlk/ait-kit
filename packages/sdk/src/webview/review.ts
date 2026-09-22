import { resolvePlatformLoader } from "../platform-loader.js";
import { createWebViewPlatformLoader } from "./platform-loader.js";
import { createReviewAdapter } from "../review/adapter.js";
import type { ReviewAdapter, ReviewPlatformLoader, ReviewPlatformSdk } from "../review/platform-contract.js";

export interface WebViewReviewOptions {
  /** Shared contract injection, or a loader; defaults to the lazy official SDK. */
  framework?: ReviewPlatformSdk | ReviewPlatformLoader;
}

export function createWebViewReview(options: WebViewReviewOptions = {}): ReviewAdapter {
  return createReviewAdapter(resolvePlatformLoader(options.framework, createDefaultReviewLoader));
}

function createDefaultReviewLoader(): ReviewPlatformLoader {
  return createWebViewPlatformLoader(module => ({ available: true, module: module }), false);
}

/** @deprecated Use createWebViewReview from @ait-kit/sdk/webview. */
export const createWebReview = createWebViewReview;
/** @deprecated Use WebViewReviewOptions from @ait-kit/sdk/webview. */
export type WebReviewOptions = WebViewReviewOptions;
