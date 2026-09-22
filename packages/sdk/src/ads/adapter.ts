import { SdkError, type AdReward, type AdShowResult } from "../index.js";
import { runEventFlow } from "../event-flow.js";
import type { FullScreenAdShowEvent, FullScreenAdSupport } from "./platform-contract.js";
import type { PlatformLoader } from "../platform-loader.js";
export type AdsPlatformLoader = PlatformLoader<FullScreenAdSupport>;

/** Ad kinds the SDK distinguishes; only full-screen ads exist today. */
export type SdkAdType = "fullscreen";

export interface AdsOptions {
  /** Resolved platform loader, supplied by the runtime-specific factory. */
  loader: AdsPlatformLoader;
  /** Overall deadline for the show flow (default 60000ms; 0 disables). */
  showTimeoutMs?: number;
  /**
   * Overall deadline for each load, covering framework acquisition and the
   * provider load flow (default 30000ms; 0 disables).
   */
  loadTimeoutMs?: number;
}

export interface AdsAdapter {
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
 * One overall budget shared by framework acquisition and the event flow.
 * The loader races the configured budget, and whatever remains when the
 * loader finishes becomes the event flow's own deadline — so the timeout
 * the caller observes is enforced by the flow itself, whose subscription
 * cleanup completes before the result settles (never by an outside race
 * that abandons a still-listening flow).
 */
interface AdDeadline {
  /** Remaining budget in ms, or undefined when no deadline is configured. */
  remainingMs(): number | undefined;
  /**
   * Races a promise against the full budget. Resolves `undefined` when the
   * budget runs out first (a later settlement of the raced promise is sunk
   * and must never lead to a registration); rejections propagate.
   */
  race<T>(promise: Promise<T>): Promise<T | undefined>;
}

function createAdDeadline(timeoutMs: number, now: () => number = monotonicNow): AdDeadline {
  if (!(timeoutMs > 0)) {
    return { remainingMs: () => undefined, race: (promise) => promise };
  }
  const startedAt = now();
  return {
    remainingMs: () => timeoutMs - (now() - startedAt),
    race: (promise) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(undefined), timeoutMs);
        // Attaching handlers also sinks a settlement that happens after the
        // deadline already won; the no-op reject/resolve after settling is
        // ignored by promise semantics.
        promise.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          }
        );
      })
  };
}

/**
 * Monotonic elapsed time: a system wall-clock correction while the loader
 * is pending must not shrink or stretch the remaining budget.
 */
function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Shared full-screen ad adapter. Load state is
 * tracked per ad type + ad unit, in-flight duplicate loads share one
 * request, and rewards come only from the provider's `userEarnedReward`
 * event. The adapter produces ad outcomes; server-side reward requests,
 * session checks, and ledger handling belong to the consumer.
 */
export function createAdsAdapter(options: AdsOptions): AdsAdapter {
  const loader = options.loader;
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

    // Slot updates run inside this promise's settlement — before the
    // caller's await/catch continuation — so a caller that immediately
    // retries after a failure starts a fresh registration, and a caller
    // that immediately shows after a success finds the slot loaded. The
    // identity check keeps a stale task from touching a newer task's slot.
    const promise = new Promise<void>((resolve, reject) => {
      runLoad(adGroupId).then(
        () => {
          const current = slots.get(id);
          if (current?.kind === "loading" && current.promise === promise) {
            slots.set(id, { kind: "loaded" });
          }
          resolve();
        },
        (error: unknown) => {
          const current = slots.get(id);
          if (current?.kind === "loading" && current.promise === promise) {
            slots.delete(id);
          }
          reject(error);
        }
      );
    });
    slots.set(id, { kind: "loading", promise });
    return promise;
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

    return (async (): Promise<AdShowResult> => {
      const timedOut = (): AdShowResult => ({ status: "failed", reason: "ad show flow timed out" });
      try {
        // The whole show shares one budget: the loader races it, the event
        // flow gets what remains, and the flow's own deadline produces the
        // timeout result — its subscription cleanup completes before this
        // promise settles, so `showing` is only released after the
        // subscription is gone.
        const deadline = createAdDeadline(showTimeoutMs);
        const framework = await deadline.race(loadFramework());
        if (!framework) {
          return timedOut();
        }
        if (
          typeof framework.showFullScreenAd.isSupported === "function" &&
          !framework.showFullScreenAd.isSupported()
        ) {
          throw new SdkError("UNSUPPORTED", "full-screen ads are not supported on this app version");
        }
        const remaining = deadline.remainingMs();
        if (remaining !== undefined && remaining <= 0) {
          return timedOut();
        }
        let reward: AdReward | undefined;
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
          onTimeout: timedOut,
          timeoutMs: remaining ?? 0
        });
      } finally {
        showing.delete(id);
      }
    })();
  };

  async function runLoad(adGroupId: string): Promise<void> {
    // One deadline covers framework acquisition AND the provider flow. A
    // loader that wins the race only just — or too late — leaves no budget
    // for the provider registration, which is then skipped entirely.
    const deadline = createAdDeadline(loadTimeoutMs);
    const framework = await deadline.race(loadFramework());
    if (!framework) {
      throw new SdkError("AD_LOAD_TIMEOUT", "full-screen ad load timed out");
    }
    if (
      typeof framework.loadFullScreenAd.isSupported === "function" &&
      !framework.loadFullScreenAd.isSupported()
    ) {
      throw new SdkError("UNSUPPORTED", "full-screen ads are not supported on this app version");
    }
    const remaining = deadline.remainingMs();
    if (remaining !== undefined && remaining <= 0) {
      throw new SdkError("AD_LOAD_TIMEOUT", "full-screen ad load timed out");
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
      timeoutMs: remaining ?? 0
    });
    if (outcome instanceof SdkError) {
      throw outcome;
    }
  }

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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
