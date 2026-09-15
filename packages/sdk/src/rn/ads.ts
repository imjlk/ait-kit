import { SdkError, type AdReward, type AdShowResult } from "../index";
import { runEventFlow } from "../event-flow";
import type { FullScreenAdShowEvent, FullScreenAdSupport } from "./framework-contract";
import { createDefaultFrameworkLoader, type FrameworkLoader } from "./framework-loader";

/** Ad kinds the SDK distinguishes; only full-screen ads exist today. */
export type SdkAdType = "fullscreen";

export interface ReactNativeAdsOptions {
  /**
   * Framework loader. Defaults to a lazy `import("@apps-in-toss/framework")`
   * that retries after failures; tests and consumers can inject a loader or
   * a module instance directly.
   */
  framework?: FrameworkLoader | FullScreenAdSupport;
  /** Overall deadline for the show flow (default 60000ms; 0 disables). */
  showTimeoutMs?: number;
  /** Deadline for each load flow (default 30000ms; 0 disables). */
  loadTimeoutMs?: number;
}

export interface ReactNativeAds {
  /** Loads (or joins an in-flight load of) the full-screen ad for adGroupId. */
  loadFullScreenAd(adGroupId: string): Promise<void>;
  /**
   * Shows the previously loaded full-screen ad and resolves with its
   * terminal outcome. The ad is single-use: after the flow ends, a new load
   * is required before the next show.
   */
  showFullScreenAd(adGroupId: string): Promise<AdShowResult>;
}

type LoadFlowEvent = { type: "loaded" } | { type: "sdkError"; error: unknown };
type ShowFlowEvent = FullScreenAdShowEvent | { type: "sdkError"; error: unknown };

const DEFAULT_SHOW_TIMEOUT_MS = 60_000;
const DEFAULT_LOAD_TIMEOUT_MS = 30_000;

/**
 * React Native ad adapter over `@apps-in-toss/framework`. Load state is
 * tracked per ad type + ad unit, in-flight duplicate loads share one
 * request, and rewards come only from the provider's `userEarnedReward`
 * event. The adapter produces ad outcomes; server-side reward requests,
 * session checks, and ledger handling belong to the consumer.
 */
export function createReactNativeAds(options: ReactNativeAdsOptions = {}): ReactNativeAds {
  const loader = normalizeLoader(options.framework);
  const showTimeoutMs = options.showTimeoutMs ?? DEFAULT_SHOW_TIMEOUT_MS;
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;

  // Load state keyed by `${adType}:${adGroupId}`. Absent means "needs load";
  // a resolved promise is the loaded marker consumed by the show flow.
  const loads = new Map<string, Promise<void>>();
  const showing = new Set<string>();

  const adKey = (adType: SdkAdType, adGroupId: string) => `${adType}:${adGroupId}`;

  const load = (adGroupId: string): Promise<void> => {
    const id = adKey("fullscreen", adGroupId);
    const inFlight = loads.get(id);
    // A duplicate load joins the in-flight (or already loaded) request
    // instead of stacking a second SDK registration for the same unit.
    if (inFlight) {
      return inFlight;
    }

    const request = (async () => {
      const framework = await loadFramework();
      if (
        typeof framework.loadFullScreenAd.isSupported === "function" &&
        !framework.loadFullScreenAd.isSupported()
      ) {
        throw new SdkError("UNSUPPORTED", "full-screen ads are not supported on this app version");
      }
      const outcome = await runEventFlow<LoadFlowEvent, void | SdkError>({
        register: (emit) =>
          framework.loadFullScreenAd({
            options: { adGroupId },
            onEvent: emit,
            onError: (error) => emit({ type: "sdkError", error })
          }),
        reduce: (event) =>
          event.type === "loaded"
            ? { done: true, result: undefined }
            : { done: true, result: toSdkError("load", event.error) },
        onTimeout: () => new SdkError("UNSUPPORTED", "full-screen ad load timed out"),
        timeoutMs: loadTimeoutMs
      });
      if (outcome instanceof SdkError) {
        throw outcome;
      }
    })();

    loads.set(id, request);
    // A failed load never blocks the next attempt: clear the slot on
    // rejection so a retry registers fresh. Successful loads keep their
    // resolved marker until the show flow consumes it.
    request.catch(() => {
      loads.delete(id);
    });
    return request;
  };

  const show = (adGroupId: string): Promise<AdShowResult> => {
    const id = adKey("fullscreen", adGroupId);
    const loaded = loads.get(id);
    if (!loaded) {
      return Promise.reject(
        new SdkError("AD_NOT_LOADED", `loadFullScreenAd must succeed before showing ad group ${adGroupId}`)
      );
    }
    if (showing.has(id)) {
      return Promise.reject(
        new SdkError("AD_ALREADY_SHOWING", `ad group ${adGroupId} is already being shown`)
      );
    }
    // Claim the showing slot synchronously so a concurrent call cannot slip
    // past the guard while this one is still awaiting.
    showing.add(id);

    return (async () => {
      let reward: AdReward | undefined;
      try {
        // Surface a failed load through the show call without swallowing it.
        await loaded;
        const framework = await loadFramework();
        if (
          typeof framework.showFullScreenAd.isSupported === "function" &&
          !framework.showFullScreenAd.isSupported()
        ) {
          throw new SdkError("UNSUPPORTED", "full-screen ads are not supported on this app version");
        }

        return await runEventFlow<ShowFlowEvent, AdShowResult>({
          register: (emit) =>
            framework.showFullScreenAd({
              options: { adGroupId },
              onEvent: emit,
              onError: (error) => emit({ type: "sdkError", error })
            }),
          reduce: (event) => {
            if (event.type === "sdkError") {
              const message = errorMessage(event.error);
              return {
                done: true,
                result: { status: "failed", reason: `full-screen ad show failed: ${message}` }
              };
            }
            return reduceShowEvent(event, () => reward, (value) => (reward = value));
          },
          onTimeout: () => ({ status: "failed", reason: "ad show flow timed out" }),
          timeoutMs: showTimeoutMs
        });
      } finally {
        showing.delete(id);
        // Full-screen ads are single-use: consume the loaded marker so the
        // next attempt must load again. A failed load also clears the way
        // for a retry.
        loads.delete(id);
      }
    })();
  };

  async function loadFramework(): Promise<FullScreenAdSupport> {
    const result = await loader();
    if (!result.available) {
      throw new SdkError("SDK_UNAVAILABLE", result.reason);
    }
    return result.module;
  }

  return { loadFullScreenAd: load, showFullScreenAd: show };
}

function reduceShowEvent(
  event: FullScreenAdShowEvent,
  getReward: () => AdReward | undefined,
  setReward: (reward: AdReward) => void
): { done: true; result: AdShowResult } | { done: false } {
  switch (event.type) {
    case "userEarnedReward": {
      if (event.data) {
        setReward({ unitType: event.data.unitType, unitAmount: event.data.unitAmount });
      }
      return { done: false };
    }
    case "dismissed": {
      const earned = getReward();
      // Reward only when the provider actually emitted userEarnedReward;
      // dismissal alone never grants anything.
      return earned
        ? { done: true, result: { status: "rewarded", reward: earned } }
        : { done: true, result: { status: "dismissed" } };
    }
    case "failedToShow":
      return { done: true, result: { status: "failed", reason: "failedToShow" } };
    default:
      // requested / show / impression / clicked keep the flow running.
      return { done: false };
  }
}

function toSdkError(phase: "load" | "show", error: unknown): SdkError {
  if (error instanceof SdkError) return error;
  return new SdkError("UNSUPPORTED", `full-screen ad ${phase} failed: ${errorMessage(error)}`, {
    cause: error
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLoader(framework: ReactNativeAdsOptions["framework"]): FrameworkLoader {
  if (!framework) {
    return createDefaultFrameworkLoader();
  }
  if (typeof framework === "function") {
    return framework;
  }
  return async () => ({ available: true, module: framework });
}
