import { describe, expect, test } from "bun:test";
import { createSdkDiagnostics } from "../src/diagnostics.js";
import { SdkError, type SdkAnonymousKey, type SdkAnonymousKeyLookupOptions } from "../src/index.js";
import { createReactNativeIdentity } from "../src/rn";
import { createWebViewIdentity } from "../src/webview";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A host bridge whose answers the test controls; every call is recorded. */
function controllableBridge() {
  const calls: Deferred<unknown>[] = [];
  const platform = {
    User: {
      getAnonymousKey: Object.assign(
        () => {
          const call = deferred<unknown>();
          calls.push(call);
          return call.promise;
        },
        { isSupported: () => true }
      )
    }
  };
  return { calls, platform };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = () => sleep(0);

type Lookup = (options?: SdkAnonymousKeyLookupOptions) => Promise<SdkAnonymousKey>;

const adapters: Array<[string, (platform: ReturnType<typeof controllableBridge>["platform"]) => Lookup]> = [
  ["WebView", (platform) => {
    const identity = createWebViewIdentity({ framework: platform });
    return (options) => identity.getAnonymousKey(options);
  }],
  ["React Native", (platform) => {
    const identity = createReactNativeIdentity({ framework: platform });
    return (options) => identity.getAnonymousKey(options);
  }]
];

for (const [name, create] of adapters) {
  describe(`${name} anonymous key lookup`, () => {
    test("concurrent callers share one SDK call", async () => {
      const bridge = controllableBridge();
      const lookup = create(bridge.platform);
      const first = lookup();
      const second = lookup({ timeoutMs: 1_000 });
      const third = lookup();
      await flush();
      expect(bridge.calls).toHaveLength(1);
      bridge.calls[0]!.resolve({ type: "HASH", hash: "hash-1" });
      expect(await Promise.all([first, second, third])).toEqual([
        { type: "HASH", hash: "hash-1" },
        { type: "HASH", hash: "hash-1" },
        { type: "HASH", hash: "hash-1" }
      ]);
      expect(bridge.calls).toHaveLength(1);
    });

    test("SDK rejections reach every joined caller unchanged", async () => {
      const bridge = controllableBridge();
      const lookup = create(bridge.platform);
      const first = lookup();
      const second = lookup({ timeoutMs: 1_000 });
      await flush();
      const sdkError = new Error("bridge failed");
      bridge.calls[0]!.reject(sdkError);
      const [a, b] = await Promise.allSettled([first, second]);
      expect(a).toEqual({ status: "rejected", reason: sdkError });
      expect(b).toEqual({ status: "rejected", reason: sdkError });
      expect((a as PromiseRejectedResult).reason).toBe(sdkError);
      expect((b as PromiseRejectedResult).reason).toBe(sdkError);
      expect(bridge.calls).toHaveLength(1);
    });

    test("a timed-out caller rejects with TIMEOUT and later callers join the pending call", async () => {
      const bridge = controllableBridge();
      const lookup = create(bridge.platform);
      const timedOut = lookup({ timeoutMs: 10 });
      await expect(timedOut).rejects.toBeInstanceOf(SdkError);
      await expect(timedOut).rejects.toMatchObject({ code: "TIMEOUT" });

      // The bridge never answered; a second deadline-bound caller and an
      // unbounded caller both join it rather than adding a listener.
      await expect(lookup({ timeoutMs: 10 })).rejects.toMatchObject({ code: "TIMEOUT" });
      const joined = lookup();
      await flush();
      expect(bridge.calls).toHaveLength(1);

      bridge.calls[0]!.resolve({ type: "HASH", hash: "late-hash" });
      expect(await joined).toEqual({ type: "HASH", hash: "late-hash" });
      expect(bridge.calls).toHaveLength(1);
    });

    test("the next lookup after a settled call asks the SDK again", async () => {
      const bridge = controllableBridge();
      const lookup = create(bridge.platform);

      const first = lookup();
      await flush();
      bridge.calls[0]!.resolve({ type: "HASH", hash: "hash-1" });
      expect(await first).toEqual({ type: "HASH", hash: "hash-1" });

      // Immediately after the awaited result: no cached value or stale call.
      const second = lookup();
      await flush();
      expect(bridge.calls).toHaveLength(2);
      bridge.calls[1]!.reject(new Error("transient"));
      await expect(second).rejects.toThrow("transient");

      const third = lookup();
      await flush();
      expect(bridge.calls).toHaveLength(3);
      bridge.calls[2]!.resolve({ type: "HASH", hash: "hash-3" });
      expect(await third).toEqual({ type: "HASH", hash: "hash-3" });
    });

    test("a shared call that settles after every caller timed out is released quietly", async () => {
      const bridge = controllableBridge();
      const lookup = create(bridge.platform);
      await expect(lookup({ timeoutMs: 5 })).rejects.toMatchObject({ code: "TIMEOUT" });
      // Nobody is waiting any more; the rejection must not surface as unhandled.
      bridge.calls[0]!.reject(new Error("late failure"));
      await flush();
      const next = lookup();
      await flush();
      expect(bridge.calls).toHaveLength(2);
      bridge.calls[1]!.resolve({ type: "HASH", hash: "hash-2" });
      expect(await next).toEqual({ type: "HASH", hash: "hash-2" });
    });

    test("without timeoutMs (or with 0) a slow SDK call is awaited as before", async () => {
      const bridge = controllableBridge();
      const lookup = create(bridge.platform);
      let settled = false;
      const unbounded = lookup().finally(() => { settled = true; });
      const zero = lookup({ timeoutMs: 0 });
      await sleep(30);
      expect(settled).toBe(false);
      bridge.calls[0]!.resolve({ type: "HASH", hash: "slow-hash" });
      expect(await unbounded).toEqual({ type: "HASH", hash: "slow-hash" });
      expect(await zero).toEqual({ type: "HASH", hash: "slow-hash" });
    });

    test("result validation still applies to the shared call", async () => {
      const bridge = controllableBridge();
      const lookup = create(bridge.platform);
      const first = lookup();
      const second = lookup();
      await flush();
      bridge.calls[0]!.resolve({ type: "ERROR" });
      const results = await Promise.allSettled([first, second]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "INVALID_ANONYMOUS_KEY" });
      }
    });

    for (const timeoutMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, "10"]) {
      test(`rejects timeoutMs ${String(timeoutMs)} without calling the SDK`, async () => {
        const bridge = controllableBridge();
        const lookup = create(bridge.platform);
        await expect(lookup({ timeoutMs: timeoutMs as number })).rejects.toMatchObject({
          code: "INVALID_IDENTITY_INPUT"
        });
        expect(bridge.calls).toHaveLength(0);
      });
    }
  });
}

describe("anonymous key lookup deadlines", () => {
  test("clears the caller's timer when the shared call settles", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const active = new Set<unknown>();
    const longDeadline = 60_000;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      const id = realSetTimeout(() => {
        active.delete(id);
        handler();
      }, ms);
      if (ms === longDeadline) active.add(id);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
      active.delete(id);
      realClearTimeout(id);
    }) as typeof clearTimeout;
    try {
      const bridge = controllableBridge();
      const identity = createWebViewIdentity({ framework: bridge.platform });
      const resolved = identity.getAnonymousKey({ timeoutMs: longDeadline });
      await flush();
      expect(active.size).toBe(1);
      bridge.calls[0]!.resolve({ type: "HASH", hash: "hash-1" });
      await resolved;
      expect(active.size).toBe(0);

      const rejected = identity.getAnonymousKey({ timeoutMs: longDeadline });
      await flush();
      expect(active.size).toBe(1);
      bridge.calls[1]!.reject(new Error("bridge failed"));
      await expect(rejected).rejects.toThrow("bridge failed");
      expect(active.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("diagnostics classify a lookup deadline as a timeout", async () => {
    const bridge = controllableBridge();
    const identity = createWebViewIdentity({ framework: bridge.platform });
    const diagnostics = createSdkDiagnostics({ enabled: true });
    await expect(
      diagnostics.run("identity.lookup", () => identity.getAnonymousKey({ timeoutMs: 5 }))
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(diagnostics.snapshot().at(-1)).toMatchObject({
      operation: "identity.lookup",
      phase: "finish",
      outcome: "timeout"
    });
  });

  test("the shared call covers a stalled loader too", async () => {
    let loads = 0;
    const loaderGate = deferred<void>();
    const identity = createWebViewIdentity({
      framework: async () => {
        loads++;
        await loaderGate.promise;
        return {
          available: true as const,
          module: { User: { getAnonymousKey: async () => ({ type: "HASH", hash: "hash-1" }) } }
        };
      }
    });
    await expect(identity.getAnonymousKey({ timeoutMs: 5 })).rejects.toMatchObject({ code: "TIMEOUT" });
    const joined = identity.getAnonymousKey();
    await flush();
    expect(loads).toBe(1);
    loaderGate.resolve();
    expect(await joined).toEqual({ type: "HASH", hash: "hash-1" });
  });
});

describe("anonymous authentication codes", () => {
  test("concurrent createAnonymousKeyAuthCode calls are never shared", async () => {
    const pending: Deferred<unknown>[] = [];
    const identity = createWebViewIdentity({
      framework: {
        User: {
          getAnonymousKey: undefined,
          createAnonymousKeyAuthCode: () => {
            const call = deferred<unknown>();
            pending.push(call);
            return call.promise;
          }
        }
      }
    });
    const first = identity.createAnonymousKeyAuthCode();
    const second = identity.createAnonymousKeyAuthCode();
    await flush();
    expect(pending).toHaveLength(2);
    pending[0]!.resolve({ code: "code-1", expiresIn: 300 });
    pending[1]!.resolve({ code: "code-2", expiresIn: 300 });
    expect(await first).toEqual({ code: "code-1", expiresIn: 300 });
    expect(await second).toEqual({ code: "code-2", expiresIn: 300 });
  });

  test("a pending anonymous key lookup does not capture auth-code requests", async () => {
    const bridge = controllableBridge();
    let codes = 0;
    const identity = createWebViewIdentity({
      framework: {
        User: {
          ...bridge.platform.User,
          createAnonymousKeyAuthCode: async () => ({ code: `code-${++codes}`, expiresIn: 300 })
        }
      }
    });
    const lookup = identity.getAnonymousKey();
    expect(await identity.createAnonymousKeyAuthCode()).toEqual({ code: "code-1", expiresIn: 300 });
    expect(await identity.createAnonymousKeyAuthCode()).toEqual({ code: "code-2", expiresIn: 300 });
    bridge.calls[0]!.resolve({ type: "HASH", hash: "hash-1" });
    expect(await lookup).toEqual({ type: "HASH", hash: "hash-1" });
  });
});
