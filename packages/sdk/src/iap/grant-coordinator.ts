import type { IapGrantTarget } from "./platform-contract.js";

/**
 * Client-side dedupe for server grant callbacks, scoped to one adapter
 * instance (one "processing scope"):
 *
 * - Concurrent grants for the same order share the in-flight Promise, so a
 *   duplicate callback never re-runs the server request.
 * - A successfully granted order is reused within the same scope: later
 *   flows (pending-order recovery, duplicate success events) resolve
 *   immediately instead of re-granting.
 * - Failed grants are never cached: the entry is removed when the attempt
 *   rejects, so the next call retries for real.
 *
 * This only reduces duplicate client-side work. Server-side grant
 * idempotency (verify the order, persist exactly once) is a separate,
 * mandatory server responsibility.
 */
export class IapGrantCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly granted = new Set<string>();

  constructor(private readonly grant: (target: IapGrantTarget) => Promise<void>) {}

  /**
   * Runs (or joins) the grant for the target order. Resolves when the
   * consumer's callback resolves; rejects with the callback's error when it
   * fails, leaving the order retryable.
   */
  run(target: IapGrantTarget): Promise<void> {
    const existing = this.inFlight.get(target.orderId);
    if (existing) {
      return existing;
    }
    if (this.granted.has(target.orderId)) {
      return Promise.resolve();
    }
    const attempt = (async () => {
      await this.grant(target);
      // Only successful grants persist: the consumer's contract is to
      // resolve after the server verified the order and persisted the grant.
      this.granted.add(target.orderId);
    })();
    this.inFlight.set(target.orderId, attempt);
    attempt
      .catch(() => {
        // Failures are not cached; a later call retries the callback.
      })
      .finally(() => {
        this.inFlight.delete(target.orderId);
      });
    return attempt;
  }

  /** True when this scope already granted the order successfully. */
  isGranted(orderId: string): boolean {
    return this.granted.has(orderId);
  }
}
