/**
 * Structural contract for the official React Native and WebView full-screen Ads APIs,
 * declared from the published documentation so this package type-checks and
 * ships without requiring the official SDK to be installed. The runtime
 * module stays an optional peer dependency.
 */

export interface LoadFullScreenAdParams {
  options: { adGroupId: string };
  onEvent: (event: { type: "loaded" }) => void;
  onError: (error: unknown) => void;
}

/** Discriminated union per the provider contract: only userEarnedReward carries data. */
export type FullScreenAdShowEvent =
  | { type: "requested" | "show" | "impression" | "clicked" | "dismissed" | "failedToShow" }
  | { type: "userEarnedReward"; data: { unitType: string; unitAmount: number } };

export interface ShowFullScreenAdParams {
  options: { adGroupId: string };
  onEvent: (event: FullScreenAdShowEvent) => void;
  onError: (error: unknown) => void;
}

export interface FullScreenAdFunctions {
  loadFullScreenAd(params: LoadFullScreenAdParams): () => void;
  showFullScreenAd(params: ShowFullScreenAdParams): () => void;
}

export interface FullScreenAdSupport {
  loadFullScreenAd: FullScreenAdFunctions["loadFullScreenAd"] & {
    isSupported?: () => boolean;
  };
  showFullScreenAd: FullScreenAdFunctions["showFullScreenAd"] & {
    isSupported?: () => boolean;
  };
}
