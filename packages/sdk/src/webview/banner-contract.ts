export interface WebViewBannerEvent {
  slotId: string;
  adGroupId: string;
  adMetadata: { creativeId: string; requestId: string };
}
export interface WebViewBannerError {
  slotId: string;
  adGroupId: string;
  adMetadata: Record<string, never>;
  error: { code: number; message: string; domain?: string; mediationId?: string };
}
export interface WebViewBannerCallbacks {
  onAdRendered?: (payload: WebViewBannerEvent) => void;
  onAdViewable?: (payload: WebViewBannerEvent) => void;
  onAdClicked?: (payload: WebViewBannerEvent) => void;
  onAdImpression?: (payload: WebViewBannerEvent) => void;
  onAdFailedToRender?: (payload: WebViewBannerError) => void;
  onNoFill?: (payload: { slotId: string; adGroupId: string; adMetadata: Record<string, never> }) => void;
}
export interface WebViewBannerOptions {
  theme?: "auto" | "light" | "dark";
  tone?: "blackAndWhite" | "grey";
  variant?: "card" | "expanded";
  callbacks?: WebViewBannerCallbacks;
  /** Cancels pending attachment and destroys this banner on abort. */
  signal?: AbortSignal;
}
export interface WebViewBannerHandle { destroy(): void; }
type Supported<F> = F & { isSupported?: () => boolean };
export interface WebViewBannerPlatform {
  TossAds?: {
    /** Must tolerate repeated calls after failures/timeouts, like official idempotent initialization. */
    initialize?: Supported<(options: { callbacks?: { onInitialized?: () => void; onInitializationFailed?: (error: Error) => void } }) => void>;
    attachBanner?: Supported<(adGroupId: string, target: string | HTMLElement, options?: Omit<WebViewBannerOptions, "signal">) => WebViewBannerHandle>;
  };
}
