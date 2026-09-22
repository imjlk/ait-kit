import { SdkError } from "../index.js";
import { resolvePlatformLoader, type PlatformLoader } from "../platform-loader.js";
import { createWebViewPlatformLoader } from "./platform-loader.js";
import type { WebViewBannerHandle, WebViewBannerOptions, WebViewBannerPlatform, WebViewBannerCallbacks, WebViewBannerError } from "./banner-contract.js";
export type { WebViewBannerHandle, WebViewBannerOptions, WebViewBannerEvent, WebViewBannerError, WebViewBannerCallbacks, WebViewBannerPlatform } from "./banner-contract.js";

export interface WebViewBannerAdsOptions {
  framework?: WebViewBannerPlatform | PlatformLoader<WebViewBannerPlatform>;
  /** Overall initialization deadline including SDK import; default 15000ms. */
  initializeTimeoutMs?: number;
}
export interface WebViewBannerAds {
  initialize(): Promise<void>;
  /** Resolves once attached, not once rendered. Own a distinct target per live handle. */
  attachBanner(adGroupId: string, target: string | HTMLElement, options?: WebViewBannerOptions): Promise<WebViewBannerHandle>;
}
// Prevent two adapter instances from claiming the provider's same-element shared handle.
const claimedTargets = new WeakSet<object>();

export function createWebViewBannerAds(options: WebViewBannerAdsOptions = {}): WebViewBannerAds {
  const timeoutMs = options.initializeTimeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SdkError("INVALID_BANNER_INPUT", "initializeTimeoutMs must be positive and finite");
  const loader = resolvePlatformLoader(options.framework, () => createWebViewPlatformLoader(module => ({ available: true, module })));
  let initialized: WebViewBannerPlatform | undefined;
  let pending: Promise<void> | undefined;

  const initialize = (): Promise<void> => {
    if (initialized) return Promise.resolve();
    if (pending) return pending;
    const started = now();
    const operation = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, module?: WebViewBannerPlatform) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (module === undefined) reject(error);
        else { initialized = module; resolve(); }
      };
      const expired = () => now() - started >= timeoutMs;
      const timeout = () => new SdkError("BANNER_INIT_TIMEOUT", "banner initialization timed out");
      const timer = setTimeout(() => finish(timeout()), timeoutMs);
      Promise.resolve().then(loader).then(result => {
        if (settled) return;
        if (expired()) { finish(timeout()); return; }
        if (!result.available) { finish(new SdkError("SDK_UNAVAILABLE", result.reason)); return; }
        const api = result.module.TossAds;
        const init = api?.initialize;
        if (!supported(init)) { finish(new SdkError("UNSUPPORTED", "banner initialization is not supported")); return; }
        if (expired()) { finish(timeout()); return; }
        let registering = true;
        let outcome: { ok: true } | { ok: false; error: Error } | undefined;
        const complete = (value: NonNullable<typeof outcome>) => {
          if (outcome) return;
          outcome = value;
          if (!registering) settleOutcome();
        };
        const settleOutcome = () => {
          if (expired()) finish(timeout());
          else if (outcome?.ok) finish(undefined, result.module);
          else if (outcome) finish(outcome.error);
        };
        init.call(api, { callbacks: {
          onInitialized: () => complete({ ok: true }),
          onInitializationFailed: error => complete({ ok: false, error })
        } });
        registering = false;
        if (outcome) settleOutcome();
      }).catch(error => finish(error));
    });
    pending = operation;
    void operation.then(() => { pending = undefined; }, () => { pending = undefined; });
    return operation;
  };

  return { initialize, async attachBanner(adGroupId, target, attachOptions = {}) {
    if (typeof adGroupId !== "string" || !adGroupId.trim()) throw new SdkError("INVALID_BANNER_INPUT", "adGroupId must be non-empty");
    let element: Element | null;
    try {
      element = typeof target === "string" ? (typeof document === "undefined" ? null : document.querySelector(target)) : target;
    } catch (error) {
      throw new SdkError("INVALID_BANNER_INPUT", "banner target selector is invalid", { cause: error });
    }
    // Namespace validation also accepts HTML elements from another document realm.
    if (!element || element.nodeType !== 1 || element.namespaceURI !== "http://www.w3.org/1999/xhtml") {
      throw new SdkError("INVALID_BANNER_INPUT", "banner target must resolve to an HTML element");
    }
    if (claimedTargets.has(element)) throw new SdkError("BANNER_TARGET_IN_USE", "destroy the existing banner before reusing its target");
    const { signal, callbacks, ...style } = attachOptions;
    throwIfAborted(signal);
    claimedTargets.add(element);
    let destroyed = false;
    let providerHandle: WebViewBannerHandle | undefined;
    const handle: WebViewBannerHandle = { destroy() {
      if (destroyed) return;
      destroyed = true;
      signal?.removeEventListener("abort", onAbort);
      try { providerHandle?.destroy(); }
      finally { claimedTargets.delete(element); }
    } };
    const onAbort = () => handle.destroy();
    try {
      await initialize();
      throwIfAborted(signal);
      const api = initialized?.TossAds;
      const attach = api?.attachBanner;
      if (!supported(attach)) throw new SdkError("UNSUPPORTED", "banner attachment is not supported");
      let registering = true;
      let registrationError: WebViewBannerError | undefined;
      // Capture the resource before invoking consumer callbacks, including
      // callbacks the provider emits synchronously during registration.
      const forward = <P>(callback: ((payload: P) => void) | undefined) => (payload: P) => {
        if (callback) queueMicrotask(() => { if (!destroyed) callback(payload); });
      };
      const forwarded: Required<WebViewBannerCallbacks> = {
        onAdRendered: forward(callbacks?.onAdRendered),
        onAdViewable: forward(callbacks?.onAdViewable),
        onAdClicked: forward(callbacks?.onAdClicked),
        onAdImpression: forward(callbacks?.onAdImpression),
        onNoFill: forward(callbacks?.onNoFill),
        onAdFailedToRender: payload => {
          if (registering) registrationError = payload;
          forward(callbacks?.onAdFailedToRender)(payload);
        }
      };
      const attached = attach.call(api, adGroupId, element as HTMLElement, { ...style, callbacks: forwarded });
      registering = false;
      if (!attached || typeof attached.destroy !== "function") throw new SdkError("BANNER_ATTACH_FAILED", "provider returned no banner handle");
      providerHandle = attached;
      if (registrationError) throw new SdkError("BANNER_ATTACH_FAILED", "provider rejected banner attachment", { cause: registrationError });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { handle.destroy(); throwIfAborted(signal); }
      return handle;
    } catch (error) {
      try { handle.destroy(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "banner attachment and cleanup failed"); }
      throw error;
    }
  } };
}
function supported<F extends (...args: never[]) => unknown>(fn: (F & { isSupported?: () => boolean }) | undefined): fn is F {
  return typeof fn === "function" && (typeof fn.isSupported !== "function" || fn.isSupported());
}
function now(): number { return typeof performance !== "undefined" ? performance.now() : Date.now(); }

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Banner attachment aborted", "AbortError");
}
