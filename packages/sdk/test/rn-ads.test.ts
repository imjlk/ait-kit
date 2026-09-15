import { describe, expect, test } from "bun:test";
import { SdkError } from "../src";
import { createReactNativeAds } from "../src/rn";
import type { FullScreenAdShowEvent, FullScreenAdSupport } from "../src/rn";

interface FrameworkCall {
  phase: "load" | "show";
  adGroupId: string;
  emit: (event: unknown) => void;
  error: (error: unknown) => void;
}

type ScriptedHandler = (call: FrameworkCall) => void;

function fakeFramework(handler: ScriptedHandler): FullScreenAdSupport & {
  calls: FrameworkCall[];
  /** Invocations of the cleanup functions returned by SDK registrations. */
  cleanupCount: () => number;
} {
  const calls: FrameworkCall[] = [];
  let cleanups = 0;
  const load = ((params: Parameters<FullScreenAdSupport["loadFullScreenAd"]>[0]) => {
    const call: FrameworkCall = {
      phase: "load",
      adGroupId: params.options.adGroupId,
      emit: (event) => params.onEvent(event as { type: "loaded" }),
      error: params.onError
    };
    calls.push(call);
    handler(call);
    return () => {
      cleanups += 1;
    };
  }) as FullScreenAdSupport["loadFullScreenAd"];
  (load as { isSupported?: () => boolean }).isSupported = () => true;
  const show = ((params: Parameters<FullScreenAdSupport["showFullScreenAd"]>[0]) => {
    const call: FrameworkCall = {
      phase: "show",
      adGroupId: params.options.adGroupId,
      emit: (event) => params.onEvent(event as FullScreenAdShowEvent),
      error: params.onError
    };
    calls.push(call);
    handler(call);
    return () => {
      cleanups += 1;
    };
  }) as FullScreenAdSupport["showFullScreenAd"];
  (show as { isSupported?: () => boolean }).isSupported = () => true;
  return { loadFullScreenAd: load, showFullScreenAd: show, calls, cleanupCount: () => cleanups };
}

describe("@ait-kit/sdk/rn ads", () => {
  test("resolves a rewarded show only from the userEarnedReward event", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      }
      // Show flow runs asynchronously after registration.
      queueMicrotask(() => {
        call.emit({ type: "requested" });
        call.emit({ type: "show" });
        call.emit({ type: "impression" });
        call.emit({ type: "userEarnedReward", data: { unitType: "COIN", unitAmount: 30 } });
        call.emit({ type: "dismissed" });
      });
    });
    const ads = createReactNativeAds({ framework });

    await ads.loadFullScreenAd("group-a");
    const result = await ads.showFullScreenAd("group-a");

    expect(result).toEqual({
      status: "rewarded",
      reward: { unitType: "COIN", unitAmount: 30 }
    });
  });

  test("treats dismissal without a reward event as dismissed", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      } else {
        queueMicrotask(() => {
          call.emit({ type: "show" });
          call.emit({ type: "dismissed" });
          // A late reward event must not resurrect a decided outcome.
          call.emit({ type: "userEarnedReward", data: { unitType: "COIN", unitAmount: 5 } });
        });
      }
    });
    const ads = createReactNativeAds({ framework });

    await ads.loadFullScreenAd("group-a");
    await expect(ads.showFullScreenAd("group-a")).resolves.toEqual({ status: "dismissed" });
  });

  test("reports failedToShow and SDK errors as failures", async () => {
    const failing = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      } else {
        queueMicrotask(() => call.error(new Error("bridge gone")));
      }
    });
    const failingAds = createReactNativeAds({ framework: failing });
    await failingAds.loadFullScreenAd("group-b");
    await expect(failingAds.showFullScreenAd("group-b")).resolves.toMatchObject({
      status: "failed",
      reason: expect.stringContaining("bridge gone")
    });

    const notShown = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      } else {
        queueMicrotask(() => call.emit({ type: "failedToShow" }));
      }
    });
    const notShownAds = createReactNativeAds({ framework: notShown });
    await notShownAds.loadFullScreenAd("group-c");
    await expect(notShownAds.showFullScreenAd("group-c")).resolves.toEqual({
      status: "failed",
      reason: "failedToShow"
    });
  });

  test("times out a stalled show flow", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      }
      // Show registers but never emits.
    });
    const ads = createReactNativeAds({ framework, showTimeoutMs: 20 });
    await ads.loadFullScreenAd("group-a");

    await expect(ads.showFullScreenAd("group-a")).resolves.toEqual({
      status: "failed",
      reason: "ad show flow timed out"
    });
  });

  test("a failed load never blocks the next attempt", async () => {
    let attempt = 0;
    const framework = fakeFramework((call) => {
      if (call.phase !== "load") return;
      attempt += 1;
      if (attempt === 1) {
        queueMicrotask(() => call.error(new Error("no fill")));
      } else {
        queueMicrotask(() => call.emit({ type: "loaded" }));
      }
    });
    const ads = createReactNativeAds({ framework, loadTimeoutMs: 100 });

    await expect(ads.loadFullScreenAd("group-a")).rejects.toMatchObject({
      code: "AD_LOAD_FAILED",
      message: expect.stringContaining("no fill")
    });
    await expect(ads.loadFullScreenAd("group-a")).resolves.toBeUndefined();
    expect(framework.calls.filter((call) => call.phase === "load")).toHaveLength(2);
  });

  test("duplicate loads share one registration", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        queueMicrotask(() => call.emit({ type: "loaded" }));
      }
    });
    const ads = createReactNativeAds({ framework });

    const [first, second] = await Promise.all([
      ads.loadFullScreenAd("group-a"),
      ads.loadFullScreenAd("group-a")
    ]);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(framework.calls.filter((call) => call.phase === "load")).toHaveLength(1);
  });

  test("requires a load before showing and consumes the ad after a show", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      } else {
        queueMicrotask(() => call.emit({ type: "dismissed" }));
      }
    });
    const ads = createReactNativeAds({ framework });

    await expect(ads.showFullScreenAd("group-a")).rejects.toMatchObject({ code: "AD_NOT_LOADED" });

    await ads.loadFullScreenAd("group-a");
    await expect(ads.showFullScreenAd("group-a")).resolves.toEqual({ status: "dismissed" });

    // Full-screen ads are single-use: the consumed marker is gone.
    await expect(ads.showFullScreenAd("group-a")).rejects.toMatchObject({ code: "AD_NOT_LOADED" });
    // But a fresh load re-arms it, and a failed show does the same.
    await ads.loadFullScreenAd("group-a");
    await expect(ads.showFullScreenAd("group-a")).resolves.toEqual({ status: "dismissed" });
  });

  test("rejects showing the same ad group concurrently", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      }
      // Show registers but never emits until the test drives it.
    });
    const ads = createReactNativeAds({ framework, showTimeoutMs: 5_000 });

    await ads.loadFullScreenAd("group-a");
    const first = ads.showFullScreenAd("group-a");
    await Bun.sleep(1); // let the first show register
    await expect(ads.showFullScreenAd("group-a")).rejects.toMatchObject({ code: "AD_ALREADY_SHOWING" });

    const showCall = framework.calls.filter((call) => call.phase === "show").at(-1);
    showCall!.emit({ type: "failedToShow" });
    await expect(first).resolves.toEqual({ status: "failed", reason: "failedToShow" });

    // After the flow ends the showing flag is cleared and a new cycle works.
    await ads.loadFullScreenAd("group-a");
    const second = ads.showFullScreenAd("group-a");
    await Bun.sleep(1);
    const secondCall = framework.calls.filter((call) => call.phase === "show").at(-1);
    secondCall!.emit({ type: "dismissed" });
    await expect(second).resolves.toEqual({ status: "dismissed" });
  });

  test("rejects a show while the load is still in flight", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        queueMicrotask(() => call.emit({ type: "loaded" }));
      }
    });
    const ads = createReactNativeAds({ framework });

    const loading = ads.loadFullScreenAd("group-a");
    await expect(ads.showFullScreenAd("group-a")).rejects.toMatchObject({ code: "AD_NOT_LOADED" });
    await loading;
    const done = ads.showFullScreenAd("group-a");
    await Bun.sleep(1); // let the show register
    framework.calls
      .filter((call) => call.phase === "show")
      .forEach((call) => call.emit({ type: "dismissed" }));
    await expect(done).resolves.toEqual({ status: "dismissed" });
  });

  test("a reload during an active show registers a fresh load", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        queueMicrotask(() => call.emit({ type: "loaded" }));
      }
    });
    const ads = createReactNativeAds({ framework, showTimeoutMs: 5_000 });

    await ads.loadFullScreenAd("group-a");
    const showing = ads.showFullScreenAd("group-a");
    // Reload while the show is running: the previous marker was claimed, so
    // this is a real new registration the next show can use.
    await ads.loadFullScreenAd("group-a");
    expect(framework.calls.filter((call) => call.phase === "load")).toHaveLength(2);

    const showCall = framework.calls.filter((call) => call.phase === "show").at(-1);
    showCall!.emit({ type: "dismissed" });
    await expect(showing).resolves.toEqual({ status: "dismissed" });
    // The reloaded marker survived the first show's cleanup.
    const next = ads.showFullScreenAd("group-a");
    await Bun.sleep(1);
    framework.calls
      .filter((call) => call.phase === "show")
      .slice(-1)
      .forEach((call) => call.emit({ type: "dismissed" }));
    await expect(next).resolves.toEqual({ status: "dismissed" });
  });

  test("bounds framework acquisition with the load deadline", async () => {
    const ads = createReactNativeAds({
      framework: () => new Promise(() => {}), // loader never resolves
      loadTimeoutMs: 20
    });

    await expect(ads.loadFullScreenAd("group-a")).rejects.toMatchObject({ code: "AD_LOAD_TIMEOUT" });
  });

  test("bounds show framework acquisition with the show deadline", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        queueMicrotask(() => call.emit({ type: "loaded" }));
      }
      // Show registers but never emits; the test drives it.
    });
    let stallNextLoaderCall = false;
    const ads = createReactNativeAds({
      framework: () => {
        if (stallNextLoaderCall) {
          stallNextLoaderCall = false;
          return new Promise(() => {});
        }
        return Promise.resolve({ available: true, module: framework });
      },
      showTimeoutMs: 20
    });

    await ads.loadFullScreenAd("group-a");
    stallNextLoaderCall = true; // the show's loader call never resolves
    await expect(ads.showFullScreenAd("group-a")).resolves.toEqual({
      status: "failed",
      reason: "ad show flow timed out"
    });

    // The stalled show released its claim: a new load/show cycle works.
    await ads.loadFullScreenAd("group-a");
    const second = ads.showFullScreenAd("group-a");
    await Bun.sleep(1);
    framework.calls
      .filter((call) => call.phase === "show")
      .slice(-1)
      .forEach((call) => call.emit({ type: "dismissed" }));
    await expect(second).resolves.toEqual({ status: "dismissed" });
  });

  test("a timed-out load never registers with the provider afterwards", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        queueMicrotask(() => call.emit({ type: "loaded" }));
      }
    });
    let firstLoaderCall = true;
    let resolveFirst: (value: { available: true; module: typeof framework }) => void = () => {};
    const ads = createReactNativeAds({
      framework: () => {
        if (firstLoaderCall) {
          firstLoaderCall = false;
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ available: true, module: framework });
      },
      loadTimeoutMs: 20
    });

    await expect(ads.loadFullScreenAd("group-a")).rejects.toMatchObject({ code: "AD_LOAD_TIMEOUT" });

    // The loader resolves only after the deadline: the orphaned task must
    // not register a provider load for the cancelled request.
    resolveFirst({ available: true, module: framework });
    await Bun.sleep(5);
    expect(framework.calls.filter((call) => call.phase === "load")).toHaveLength(0);

    // A retry registers normally and succeeds.
    await expect(ads.loadFullScreenAd("group-a")).resolves.toBeUndefined();
    expect(framework.calls.filter((call) => call.phase === "load")).toHaveLength(1);
  });

  test("the load deadline covers loading plus event waiting, not each twice", async () => {
    // Behavioral discriminator instead of a tight wall-clock bound: the
    // loader consumes 40ms of a 50ms budget, leaving ~10ms for the event
    // flow. A "loaded" event 40ms after registration therefore arrives
    // AFTER the flow's own deadline (timeout wins); under the old
    // double-budget behavior the flow would have had a fresh 50ms and the
    // event would have resolved the load. Timer ordering is FIFO, so this
    // is stable on contended workers.
    const framework = fakeFramework(() => {
      // Load registration is driven manually by the test.
    });
    const ads = createReactNativeAds({
      framework: () =>
        Bun.sleep(40).then(() => ({ available: true as const, module: framework })),
      loadTimeoutMs: 50
    });

    const pending = ads.loadFullScreenAd("group-a");
    // Capture the outcome immediately so the ~50ms rejection is handled.
    const outcome = pending.then(
      () => "resolved",
      (error: unknown) => error
    );
    await Bun.sleep(55); // loader (40ms) + registration have settled
    const loadCall = framework.calls.find((call) => call.phase === "load");
    expect(loadCall).toBeDefined();
    await Bun.sleep(40); // past the flow's ~10ms remainder, inside a fresh full budget
    loadCall!.emit({ type: "loaded" });
    await expect(outcome).resolves.toMatchObject({ code: "AD_LOAD_TIMEOUT" });
  });

  test("the show deadline covers loading plus event waiting, not each twice", async () => {
    // Same discriminator for shows: after a 40ms loader within a 50ms
    // budget, a dismissal 40ms after registration is late — the timeout
    // result must win over the event.
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      }
      // Show registration is driven manually by the test.
    });
    const ads = createReactNativeAds({
      framework: () =>
        Bun.sleep(40).then(() => ({ available: true as const, module: framework })),
      showTimeoutMs: 50
    });

    await ads.loadFullScreenAd("group-a");
    const pending = ads.showFullScreenAd("group-a");
    await Bun.sleep(55); // loader (40ms) + registration have settled
    const showCall = framework.calls.find((call) => call.phase === "show");
    expect(showCall).toBeDefined();
    await Bun.sleep(40);
    showCall!.emit({ type: "dismissed" });
    await expect(pending).resolves.toEqual({
      status: "failed",
      reason: "ad show flow timed out"
    });
  });

  test("a show timeout returns exactly after its subscription cleanup ran once", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      }
      // Show registers but never emits.
    });
    const ads = createReactNativeAds({ framework, showTimeoutMs: 25 });
    await ads.loadFullScreenAd("group-a");
    const cleanupsBeforeShow = framework.cleanupCount();

    await expect(ads.showFullScreenAd("group-a")).resolves.toEqual({
      status: "failed",
      reason: "ad show flow timed out"
    });
    // The subscription was terminated before the timeout result settled:
    // exactly one cleanup, no second registration left listening.
    expect(framework.cleanupCount() - cleanupsBeforeShow).toBe(1);
    expect(framework.calls.filter((call) => call.phase === "show")).toHaveLength(1);
  });

  test("a load timeout returns exactly after its subscription cleanup ran once", async () => {
    const framework = fakeFramework(() => {
      // Load registers but never emits.
    });
    const ads = createReactNativeAds({ framework, loadTimeoutMs: 25 });

    await expect(ads.loadFullScreenAd("group-a")).rejects.toMatchObject({
      code: "AD_LOAD_TIMEOUT"
    });
    expect(framework.cleanupCount()).toBe(1);
    expect(framework.calls.filter((call) => call.phase === "load")).toHaveLength(1);
  });

  test("an immediate retry after a caught load failure starts a fresh registration", async () => {
    let attempt = 0;
    const framework = fakeFramework((call) => {
      if (call.phase !== "load") return;
      attempt += 1;
      if (attempt === 1) {
        call.error(new Error("no fill")); // synchronous failure
      } else {
        call.emit({ type: "loaded" });
      }
    });
    const ads = createReactNativeAds({ framework });

    // No sleep: the retry must observe the slot as already freed.
    try {
      await ads.loadFullScreenAd("group-a");
    } catch {
      // expected failure
    }
    await expect(ads.loadFullScreenAd("group-a")).resolves.toBeUndefined();
    expect(framework.calls.filter((call) => call.phase === "load")).toHaveLength(2);
  });

  test("an immediate show after an awaited load success never sees AD_NOT_LOADED", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        queueMicrotask(() => call.emit({ type: "loaded" }));
      } else {
        queueMicrotask(() => call.emit({ type: "dismissed" }));
      }
    });
    const ads = createReactNativeAds({ framework });

    await ads.loadFullScreenAd("group-a");
    // No sleep: the slot must already be promoted when the caller resumes.
    const shown = ads.showFullScreenAd("group-a");
    await expect(shown).resolves.toEqual({ status: "dismissed" });
  });

  test("a late show loader resolution never registers after the deadline", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      }
    });
    let resolveStalled: (value: { available: true; module: typeof framework }) => void = () => {};
    let stall = false;
    const ads = createReactNativeAds({
      framework: () => {
        if (stall) {
          stall = false;
          return new Promise((resolve) => {
            resolveStalled = resolve;
          });
        }
        return Promise.resolve({ available: true, module: framework });
      },
      showTimeoutMs: 20
    });

    await ads.loadFullScreenAd("group-a");
    stall = true;
    await expect(ads.showFullScreenAd("group-a")).resolves.toEqual({
      status: "failed",
      reason: "ad show flow timed out"
    });

    resolveStalled({ available: true, module: framework });
    await Bun.sleep(5);
    expect(framework.calls.filter((call) => call.phase === "show")).toHaveLength(0);
  });

  test("a timed-out show's late events never touch the next show's state", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      }
      // Show calls are driven manually by the test.
    });
    const ads = createReactNativeAds({ framework, showTimeoutMs: 20 });

    await ads.loadFullScreenAd("group-a");
    const stale = ads.showFullScreenAd("group-a");
    await expect(stale).resolves.toEqual({ status: "failed", reason: "ad show flow timed out" });

    // The next cycle is independent: a fresh load + show, and events fired
    // on the OLD subscription settle nothing on the new one.
    await ads.loadFullScreenAd("group-a");
    const fresh = ads.showFullScreenAd("group-a");
    await Bun.sleep(1); // let the new show register
    const showCalls = framework.calls.filter((call) => call.phase === "show");
    expect(showCalls).toHaveLength(2);
    showCalls[0].emit({ type: "dismissed" }); // stale event: ignored
    showCalls[1].emit({ type: "userEarnedReward", data: { unitType: "COIN", unitAmount: 10 } });
    showCalls[1].emit({ type: "dismissed" });
    await expect(fresh).resolves.toEqual({
      status: "rewarded",
      reward: { unitType: "COIN", unitAmount: 10 }
    });
    // Every registration cleaned up exactly once: two loads (initial +
    // reload) and two shows (timed-out + fresh).
    expect(framework.cleanupCount()).toBe(4);
  });

  test("rejects with SDK_UNAVAILABLE when the framework is missing", async () => {
    let attempts = 0;
    const ads = createReactNativeAds({
      framework: async () => {
        attempts += 1;
        return { available: false, reason: "not installed" };
      }
    });

    await expect(ads.loadFullScreenAd("group-a")).rejects.toMatchObject({
      code: "SDK_UNAVAILABLE",
      message: "not installed"
    });
    // A later successful load retries (failures are not cached).
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      }
    });
    const recovered = createReactNativeAds({
      framework: async () => {
        attempts += 1;
        return { available: true, module: framework };
      }
    });
    await expect(recovered.loadFullScreenAd("group-a")).resolves.toBeUndefined();
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  test("reports UNSUPPORTED when the ads APIs are not supported", async () => {
    const framework = fakeFramework(() => {});
    (framework.loadFullScreenAd as { isSupported?: () => boolean }).isSupported = () => false;
    const ads = createReactNativeAds({ framework });

    await expect(ads.loadFullScreenAd("group-a")).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  test("recovers when the SDK registration function throws", async () => {
    const framework = fakeFramework((call) => {
      if (call.phase === "load") {
        call.emit({ type: "loaded" });
      }
    });
    const originalShow = framework.showFullScreenAd;
    let showAttempts = 0;
    (framework as unknown as Record<string, unknown>).showFullScreenAd = ((
      params: unknown
    ) => {
      showAttempts += 1;
      if (showAttempts === 1) {
        throw new Error("bridge not ready");
      }
      return originalShow(params as Parameters<FullScreenAdSupport["showFullScreenAd"]>[0]);
    }) as typeof framework.showFullScreenAd;
    (framework.showFullScreenAd as { isSupported?: () => boolean }).isSupported = () => true;

    const ads = createReactNativeAds({ framework });
    await ads.loadFullScreenAd("group-a");

    await expect(ads.showFullScreenAd("group-a")).rejects.toThrow("bridge not ready");
    // The failed show consumed the loaded marker; a retry needs a fresh load.
    await expect(ads.showFullScreenAd("group-a")).rejects.toMatchObject({ code: "AD_NOT_LOADED" });
  });
});
