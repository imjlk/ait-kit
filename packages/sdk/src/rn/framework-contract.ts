/**
 * Structural contract for the official `@apps-in-toss/framework` Ads APIs,
 * declared from the published documentation so this package type-checks and
 * ships without requiring the official SDK to be installed. The runtime
 * module stays an optional peer dependency.
 */

export interface LoadFullScreenAdParams {
  options: { adGroupId: string };
  onEvent: (event: { type: "loaded" }) => void;
  onError: (error: unknown) => void;
}

export interface FullScreenAdShowEvent {
  type:
    | "requested"
    | "show"
    | "impression"
    | "clicked"
    | "dismissed"
    | "failedToShow"
    | "userEarnedReward";
  /** Present only on userEarnedReward. */
  data?: { unitType: string; unitAmount: number };
}

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
