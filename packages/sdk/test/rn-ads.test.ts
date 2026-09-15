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

function fakeFramework(handler: ScriptedHandler): FullScreenAdSupport & { calls: FrameworkCall[] } {
  const calls: FrameworkCall[] = [];
  const load = ((params: Parameters<FullScreenAdSupport["loadFullScreenAd"]>[0]) => {
    const call: FrameworkCall = {
      phase: "load",
      adGroupId: params.options.adGroupId,
      emit: (event) => params.onEvent(event as { type: "loaded" }),
      error: params.onError
    };
    calls.push(call);
    handler(call);
    return () => {};
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
    return () => {};
  }) as FullScreenAdSupport["showFullScreenAd"];
  (show as { isSupported?: () => boolean }).isSupported = () => true;
  return { loadFullScreenAd: load, showFullScreenAd: show, calls };
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
      code: "UNSUPPORTED",
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
