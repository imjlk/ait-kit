import { expect, test } from "bun:test";
import { createWebViewBannerAds } from "../src/webview";
import type { WebViewBannerPlatform, WebViewBannerCallbacks } from "../src/webview/banner-contract.js";
type BannerApi = NonNullable<WebViewBannerPlatform["TossAds"]>;
const target = () => ({ nodeType: 1, namespaceURI: "http://www.w3.org/1999/xhtml" }) as HTMLElement;
function fake() {
  let initCount = 0, attachCount = 0, destroyCount = 0;
  let callbacks: WebViewBannerCallbacks | undefined;
  const TossAds: NonNullable<WebViewBannerPlatform["TossAds"]> = {
    initialize: Object.assign(function(this: unknown, options: Parameters<NonNullable<BannerApi["initialize"]>>[0]) { expect(this).toBe(TossAds); initCount++; options.callbacks?.onInitialized?.(); }, { isSupported: () => true }),
    attachBanner: Object.assign(function(this: unknown, _id: string, _target: string | HTMLElement, options?: Parameters<NonNullable<BannerApi["attachBanner"]>>[2]) { expect(this).toBe(TossAds); attachCount++; callbacks = options?.callbacks; return { destroy() { destroyCount++; } }; }, { isSupported: () => true })
  };
  return { framework: { TossAds }, stats: () => ({ initCount, attachCount, destroyCount }), callbacks: () => callbacks };
}
test("coalesces initialization and destroys only the owned handle once", async () => {
  const f = fake();
  const ads = createWebViewBannerAds({ framework: f.framework });
  const a = ads.initialize(), b = ads.initialize();
  expect(a).toBe(b);
  await a;
  const first = await ads.attachBanner("a", target());
  const second = await ads.attachBanner("b", target());
  first.destroy(); first.destroy();
  expect(f.stats()).toEqual({ initCount: 1, attachCount: 2, destroyCount: 1 });
  second.destroy();
});
test("reserves a target across adapters and releases it after destroy", async () => {
  const f = fake(), el = target();
  const one = createWebViewBannerAds({ framework: f.framework });
  const two = createWebViewBannerAds({ framework: f.framework });
  const pending = one.attachBanner("a", el);
  await expect(two.attachBanner("b", el)).rejects.toMatchObject({ code: "BANNER_TARGET_IN_USE" });
  const handle = await pending;
  handle.destroy();
  const next = await two.attachBanner("b", el);
  next.destroy();
});
test("abort before initialization completes never attaches and frees the target", async () => {
  const f = fake(), el = target(), abort = new AbortController();
  let complete!: () => void;
  f.framework.TossAds.initialize = options => { complete = () => options.callbacks?.onInitialized?.(); };
  const ads = createWebViewBannerAds({ framework: f.framework });
  const pending = ads.attachBanner("a", el, { signal: abort.signal });
  await Bun.sleep(0);
  abort.abort(); complete();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(f.stats().attachCount).toBe(0);
  const next = await ads.attachBanner("a", el);
  next.destroy();
});
test("abort after attachment destroys once and suppresses late callbacks", async () => {
  const f = fake(), abort = new AbortController(); let rendered = 0;
  const ads = createWebViewBannerAds({ framework: f.framework });
  const handle = await ads.attachBanner("a", target(), { signal: abort.signal, callbacks: { onAdRendered: () => { rendered++; } } });
  abort.abort(); handle.destroy();
  f.callbacks()?.onAdRendered?.({ slotId: "s", adGroupId: "a", adMetadata: { creativeId: "c", requestId: "r" } });
  await Bun.sleep(0);
  expect(rendered).toBe(0); expect(f.stats().destroyCount).toBe(1);
});
test("synchronous render failure rejects and cleans the provider no-op handle", async () => {
  const f = fake(), el = target(); let cleaned = 0;
  f.framework.TossAds.attachBanner = (_id, _target, options) => {
    options?.callbacks?.onAdFailedToRender?.({ slotId: "", adGroupId: "a", adMetadata: {}, error: { code: 0, message: "no target" } });
    return { destroy() { cleaned++; } };
  };
  const ads = createWebViewBannerAds({ framework: f.framework });
  await expect(ads.attachBanner("a", el)).rejects.toMatchObject({ code: "BANNER_ATTACH_FAILED" });
  await expect(ads.attachBanner("a", el)).rejects.toMatchObject({ code: "BANNER_ATTACH_FAILED" });
  expect(cleaned).toBe(2);
});
test("times out SDK acquisition and never initializes after the deadline", async () => {
  const f = fake();
  let resolve!: (value: { available: true; module: WebViewBannerPlatform }) => void;
  const ads = createWebViewBannerAds({ framework: () => new Promise(done => { resolve = done; }), initializeTimeoutMs: 10 });
  await expect(ads.initialize()).rejects.toMatchObject({ code: "BANNER_INIT_TIMEOUT" });
  resolve({ available: true, module: f.framework });
  await Bun.sleep(0);
  expect(f.stats().initCount).toBe(0);
});
test("failed initialization can retry and unsupported gates never attach", async () => {
  const f = fake(); let attempts = 0;
  f.framework.TossAds.initialize = options => { attempts++; if (attempts === 1) options.callbacks?.onInitializationFailed?.(new Error("temporary")); else options.callbacks?.onInitialized?.(); };
  const ads = createWebViewBannerAds({ framework: f.framework });
  await expect(ads.initialize()).rejects.toThrow("temporary"); await ads.initialize();
  f.framework.TossAds.attachBanner!.isSupported = () => false;
  await expect(ads.attachBanner("a", target())).rejects.toMatchObject({ code: "UNSUPPORTED" });
  expect(f.stats().attachCount).toBe(0);
});

test("a synchronous provider cannot finish initialization past its elapsed deadline", async () => {
  const f = fake();
  f.framework.TossAds.initialize = options => {
    options.callbacks?.onInitialized?.();
    const start = performance.now();
    while (performance.now() - start < 20) { /* simulate a blocking host */ }
  };
  const ads = createWebViewBannerAds({ framework: f.framework, initializeTimeoutMs: 10 });
  await expect(ads.attachBanner("a", target())).rejects.toMatchObject({ code: "BANNER_INIT_TIMEOUT" });
  expect(f.stats().attachCount).toBe(0);
});

test("throwing destroy is called once, suppresses callbacks, and releases ownership", async () => {
  const f = fake(), el = target(); let cleanups = 0;
  f.framework.TossAds.attachBanner = () => ({ destroy() { cleanups++; throw new Error("cleanup"); } });
  const ads = createWebViewBannerAds({ framework: f.framework });
  const handle = await ads.attachBanner("a", el);
  expect(() => handle.destroy()).toThrow("cleanup");
  handle.destroy(); expect(cleanups).toBe(1);
  f.framework.TossAds.attachBanner = () => ({ destroy() {} });
  (await ads.attachBanner("a", el)).destroy();
});
test("failed attachment preserves both primary and cleanup failures", async () => {
  const f = fake();
  f.framework.TossAds.attachBanner = (_id, _target, options) => {
    options?.callbacks?.onAdFailedToRender?.({ slotId: "", adGroupId: "a", adMetadata: {}, error: { code: 0, message: "attach" } });
    return { destroy() { throw new Error("cleanup"); } };
  };
  const result = await createWebViewBannerAds({ framework: f.framework }).attachBanner("a", target()).catch(error => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors[0]).toMatchObject({ code: "BANNER_ATTACH_FAILED" });
  expect(result.errors[1].message).toBe("cleanup");
});
test("invalid selectors and non-HTML elements fail before SDK acquisition", async () => {
  let loaded = false;
  const ads = createWebViewBannerAds({ framework: async () => { loaded = true; return { available: true, module: {} }; } });
  await expect(ads.attachBanner("a", { nodeType: 1, namespaceURI: "http://www.w3.org/2000/svg" } as HTMLElement)).rejects.toMatchObject({ code: "INVALID_BANNER_INPUT" });
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector() { throw new DOMException("invalid selector", "SyntaxError"); } } });
    await expect(ads.attachBanner("a", "[")).rejects.toMatchObject({ code: "INVALID_BANNER_INPUT" });
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  }
  expect(loaded).toBe(false);
});

test("malformed provider handles retain the attachment error without synthetic cleanup errors", async () => {
  const f = fake(), el = target();
  f.framework.TossAds.attachBanner = () => ({}) as never;
  const ads = createWebViewBannerAds({ framework: f.framework });
  await expect(ads.attachBanner("a", el)).rejects.toMatchObject({ code: "BANNER_ATTACH_FAILED" });
  f.framework.TossAds.attachBanner = () => ({ destroy() {} });
  (await ads.attachBanner("a", el)).destroy();
});

test("rejects initialization budgets outside the portable timer range", () => {
  for (const initializeTimeoutMs of [0, -1, NaN, Infinity, 0.5, 2_147_483_648, 3_000_000_000]) {
    expect(() => createWebViewBannerAds({ initializeTimeoutMs })).toThrow(expect.objectContaining({ code: "INVALID_BANNER_INPUT" }));
  }
  expect(() => createWebViewBannerAds({ initializeTimeoutMs: 2_147_483_647 })).not.toThrow();
});
test("normalizes synchronous attachment exceptions and preserves their cause", async () => {
  const f = fake(), el = target(), cause = new Error("provider rejected");
  f.framework.TossAds.attachBanner = () => { throw cause; };
  const ads = createWebViewBannerAds({ framework: f.framework });
  await expect(ads.attachBanner("a", el)).rejects.toMatchObject({ code: "BANNER_ATTACH_FAILED", cause });
  f.framework.TossAds.attachBanner = () => ({ destroy() {} });
  (await ads.attachBanner("a", el)).destroy();
});
