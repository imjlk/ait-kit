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
  private readonly inFlight = new Map<string, { target: IapGrantTarget; promise: Promise<void> }>();
  private readonly granted = new Map<string, IapGrantTarget>();

  constructor(private readonly grant: (target: IapGrantTarget) => Promise<void>) {}

  /**
   * Runs (or joins) the grant for the target order. Resolves when the
   * consumer's callback resolves; rejects with the callback's error when it
   * fails, leaving the order retryable. A duplicate joins only when it
   * describes the same target: orderId and sku must match, and a caller
   * that does not know the subscriptionId (pending-order recovery) may join
   * a cached subscription grant. Explicitly conflicting duplicates reject
   * instead of silently inheriting another flow's grant.
   */
  run(target: IapGrantTarget): Promise<void> {
    const conflict = (existing: IapGrantTarget) =>
      new Error(
        `conflicting grant target for order ${target.orderId}: already ${existing.sku !== target.sku ? `sku ${existing.sku}` : `subscriptionId ${existing.subscriptionId}`}, requested ${target.sku}`
      );
    const sameTarget = (existing: IapGrantTarget) =>
      existing.sku === target.sku &&
      (target.subscriptionId === undefined ||
        existing.subscriptionId === undefined ||
        existing.subscriptionId === target.subscriptionId);

    const inFlight = this.inFlight.get(target.orderId);
    if (inFlight) {
      return sameTarget(inFlight.target) ? inFlight.promise : Promise.reject(conflict(inFlight.target));
    }
    const granted = this.granted.get(target.orderId);
    if (granted) {
      return sameTarget(granted) ? Promise.resolve() : Promise.reject(conflict(granted));
    }
    const attempt = (async () => {
      await this.grant(target);
      // Only successful grants persist: the consumer's contract is to
      // resolve after the server verified the order and persisted the grant.
      this.granted.set(target.orderId, target);
    })();
    this.inFlight.set(target.orderId, { target, promise: attempt });
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
