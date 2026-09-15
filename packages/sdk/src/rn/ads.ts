// Relative import: the package ships per-file output (no bundling), so
// the /rn entry and the root entry share one SdkError constructor and
// `instanceof` holds for consumers importing either entry.
import { SdkError, type AdReward, type AdShowResult } from "../index.js";
import { runEventFlow } from "../event-flow.js";
import type { FullScreenAdShowEvent, FullScreenAdSupport } from "./framework-contract.js";
import {
  createDefaultFrameworkLoader,
  type FrameworkLoader
} from "./framework-loader.js";

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
  /**
   * Overall deadline for each load, covering framework acquisition and the
   * provider load flow (default 30000ms; 0 disables).
   */
  loadTimeoutMs?: number;
}

export interface ReactNativeAds {
  /** Loads (or joins an in-flight load of) the full-screen ad for adGroupId. */
  loadFullScreenAd(adGroupId: string): Promise<void>;
  /**
   * Shows the full-screen ad whose load already completed and resolves with
   * its terminal outcome. The ad is single-use and claimed synchronously:
   * once a show starts, the unit needs a fresh load for the next attempt.
   */
  showFullScreenAd(adGroupId: string): Promise<AdShowResult>;
}

type LoadFlowEvent = { type: "loaded" } | { type: "sdkError"; error: unknown };
type ShowFlowEvent = FullScreenAdShowEvent | { type: "sdkError"; error: unknown };

/** A load is either in flight or completed; absent means "needs load". */
type LoadSlot = { kind: "loading"; promise: Promise<void> } | { kind: "loaded" };

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

  const slots = new Map<string, LoadSlot>();
  const showing = new Set<string>();

  const adKey = (adType: SdkAdType, adGroupId: string) => `${adType}:${adGroupId}`;

  const load = (adGroupId: string): Promise<void> => {
    const id = adKey("fullscreen", adGroupId);
    const existing = slots.get(id);
    // Duplicate loads join the in-flight request, and an already-completed
    // load stays loaded until a show claims it - neither re-registers.
    if (existing) {
      return existing.kind === "loaded" ? Promise.resolve() : existing.promise;
    }

    const request = (async () => {
      // The deadline covers framework acquisition as well as the provider
      // load flow: a hanging loader must not outlive loadTimeoutMs.
      const acquireAndLoad = (async () => {
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
              : { done: true, result: loadFailure(event.error) },
          onTimeout: () => new SdkError("AD_LOAD_TIMEOUT", "full-screen ad load timed out"),
          timeoutMs: loadTimeoutMs
        });
        if (outcome instanceof SdkError) {
          throw outcome;
        }
      })();
      return await withDeadline(acquireAndLoad, loadTimeoutMs);
    })();

    slots.set(id, { kind: "loading", promise: request });
    request
      .then(() => {
        // Only promote when this request still owns the slot (a show cannot
        // have claimed it before completion, but be explicit anyway).
        if (slots.get(id)?.kind === "loading") {
          slots.set(id, { kind: "loaded" });
        }
      })
      .catch(() => {
        // A failed load frees the slot so the next attempt retries.
        if (slots.get(id)?.kind === "loading") {
          slots.delete(id);
        }
      });
    return request;
  };

  const show = (adGroupId: string): Promise<AdShowResult> => {
    const id = adKey("fullscreen", adGroupId);
    if (showing.has(id)) {
      return Promise.reject(
        new SdkError("AD_ALREADY_SHOWING", `ad group ${adGroupId} is already being shown`)
      );
    }
    const slot = slots.get(id);
    if (!slot || slot.kind === "loading") {
      return Promise.reject(
        new SdkError(
          "AD_NOT_LOADED",
          `loadFullScreenAd must complete before showing ad group ${adGroupId}`
        )
      );
    }
    // Claim synchronously: the loaded marker is consumed the moment the show
    // starts, so a concurrent reload registers fresh instead of aliasing a
    // marker this show will never own again.
    slots.delete(id);
    showing.add(id);

    return (async () => {
      let reward: AdReward | undefined;
      try {
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
      // Runtime guard against payload-shape drift; the typed contract marks
      // data as required.
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

/** Transient provider failures are retryable and must not read as UNSUPPORTED. */
function loadFailure(error: unknown): SdkError {
  if (error instanceof SdkError) return error;
  return new SdkError("AD_LOAD_FAILED", `full-screen ad load failed: ${errorMessage(error)}`, {
    cause: error
  });
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!(timeoutMs > 0)) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SdkError("AD_LOAD_TIMEOUT", "full-screen ad load timed out")),
      timeoutMs
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
