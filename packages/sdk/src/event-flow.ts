/**
 * Internal, runtime-neutral event flow used by the ad adapters (and later
 * IAP flows). Not exported from any public subpath.
 *
 * Guarantees:
 * - The promise settles exactly once: success, failure, timeout, or
 *   cancellation are terminal and later events are ignored.
 * - Cleanup runs at most once. Cleanup exceptions never block settlement
 *   and never change an already-decided result.
 * - SDK registration functions that invoke a callback synchronously and
 *   then return the cleanup function are supported: the registration
 *   wrapper defers cleanup attachment until register returns.
 * - If the registration function itself throws, timers and any partially
 *   registered resources are cleaned up and the flow rejects.
 */

export type EventFlowResolution<TEvent, TResult> =
  | { done: true; result: TResult }
  | { done: false }
  | undefined;

export interface EventFlowOptions<TEvent, TResult> {
  /** Registers SDK listeners; receives the flow's emit function. Returns an optional cleanup. */
  register: (emit: (event: TEvent) => void) => (() => void) | void;
  /** Maps an emitted event to a terminal result; anything else keeps the flow running. */
  reduce: (event: TEvent) => EventFlowResolution<TEvent, TResult>;
  /** Produces the terminal result when timeoutMs elapses without a resolution. */
  onTimeout: () => TResult;
  /** Overall deadline; omit or pass 0 to disable. */
  timeoutMs?: number;
  /** Hooks for tests: scheduling and clock injection. */
  schedule?: typeof setTimeout;
  cancelSchedule?: typeof clearTimeout;
}

export function runEventFlow<TEvent, TResult>(options: EventFlowOptions<TEvent, TResult>): Promise<TResult> {
  const { register, reduce, onTimeout, timeoutMs = 0 } = options;
  const schedule = options.schedule ?? setTimeout;
  const cancelSchedule = options.cancelSchedule ?? clearTimeout;

  return new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let cleanedUp = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let registeredCleanup: (() => void) | void;

    const runCleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (timer !== undefined) {
        cancelSchedule(timer);
        timer = undefined;
      }
      if (registeredCleanup) {
        const cleanup = registeredCleanup;
        registeredCleanup = undefined;
        try {
          cleanup();
        } catch {
          // Cleanup failures must never block or alter the settled result.
        }
      }
    };

    const settle = (result: TResult) => {
      if (settled) return;
      settled = true;
      runCleanup();
      resolve(result);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      runCleanup();
      reject(error);
    };

    const emit = (event: TEvent) => {
      if (settled) return;
      const resolution = reduce(event);
      if (resolution?.done) {
        settle(resolution.result);
      }
    };

    if (timeoutMs > 0) {
      timer = schedule(() => {
        settle(onTimeout());
      }, timeoutMs);
    }

    try {
      registeredCleanup = register(emit);
    } catch (error) {
      fail(error);
      return;
    }

    // register() may have emitted synchronously and settled the flow before
    // its cleanup existed; runCleanup already fired without it, so invoke
    // the returned cleanup here with the same error-swallowing guarantee.
    if (settled && registeredCleanup) {
      const cleanup = registeredCleanup;
      registeredCleanup = undefined;
      try {
        cleanup();
      } catch {
        // Same guarantee as runCleanup.
      }
    }
  });
}
