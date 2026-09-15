import { runEventFlow } from "../event-flow.js";
import type { IapPurchaseResult, IapPurchaseSuccessInfo } from "../index.js";
import { type IapGrantCoordinator } from "./grant-coordinator.js";
import {
  type IapPlatformSdk,
  toIapErrorCode,
  toIapErrorMessage
} from "./platform-contract.js";

type PurchaseFlowEvent =
  | { kind: "sdkSuccess"; data: IapPurchaseSuccessInfo }
  | { kind: "sdkError"; error: unknown }
  | { kind: "grantSettled"; orderId: string; ok: boolean };

export interface PurchaseFlowOptions {
  platform: IapPlatformSdk;
  coordinator: IapGrantCoordinator;
  sku: string;
  offerId?: string;
  subscription: boolean;
  /** Overall deadline for the purchase flow; 0 disables. */
  timeoutMs: number;
}

/**
 * Shared purchase flow for the /rn and /web IAP adapters, built on the
 * common event-flow base:
 *
 * - The platform's `processProductGrant` slot wraps the consumer-injected
 *   server grant callback (through the coordinator's dedupe). The platform
 *   receives `true` only after the callback resolves.
 * - Completion requires the success event's orderId to match the order the
 *   grant confirmed for THIS flow. A grant for a different order ends the
 *   flow as `failed` with `ORDER_MISMATCH`, and a success event arriving
 *   before the grant settles is parked until the grant for the same order
 *   confirms — a success event alone never completes a purchase.
 * - A failed or throwing grant ends the flow as `grant_failed`; a purchase
 *   is never reported successful over a failed server grant.
 * - `USER_CANCELED` maps to `canceled`; other SDK errors to `failed`.
 * - Timeout yields `unknown` (with the known orderId when available): the
 *   server grant may already be in progress — resolve it through server
 *   verification and the pending-order recovery flow. Late events after
 *   any terminal state are ignored.
 */
export function runPurchaseFlow(options: PurchaseFlowOptions): Promise<IapPurchaseResult> {
  const { platform, coordinator, sku, offerId, subscription, timeoutMs } = options;

  // Per-flow state, shared by the register callbacks and the reducer.
  let confirmedOrderId: string | undefined;
  let confirmedSubscriptionId: string | undefined;
  let stashedSuccess: IapPurchaseSuccessInfo | undefined;
  let grantFailure: { orderId: string; reason: string } | undefined;

  const evaluate = (): { done: true; result: IapPurchaseResult } | { done: false } => {
    if (grantFailure) {
      return { done: true, result: { status: "grant_failed", ...grantFailure } };
    }
    if (stashedSuccess && confirmedOrderId !== undefined) {
      if (confirmedOrderId !== stashedSuccess.orderId) {
        return {
          done: true,
          result: {
            status: "failed",
            code: "ORDER_MISMATCH",
            reason: `grant confirmed order ${confirmedOrderId} but the success event reported ${stashedSuccess.orderId}`
          }
        };
      }
      return {
        done: true,
        result: {
          status: "completed",
          orderId: confirmedOrderId,
          ...(confirmedSubscriptionId !== undefined
            ? { subscriptionId: confirmedSubscriptionId }
            : {}),
          success: stashedSuccess
        }
      };
    }
    return { done: false };
  };

  return runEventFlow<PurchaseFlowEvent, IapPurchaseResult>({
    timeoutMs,
    onTimeout: () => ({
      status: "unknown",
      orderId: confirmedOrderId ?? stashedSuccess?.orderId,
      reason:
        "purchase flow timed out; the server grant may still be in progress — verify the order server-side and recover it via pending orders"
    }),
    register: (emit) => {
      const processProductGrant = async (params: { orderId: string; subscriptionId?: string }) => {
        try {
          await coordinator.run({
            orderId: params.orderId,
            sku,
            ...(params.subscriptionId !== undefined
              ? { subscriptionId: params.subscriptionId }
              : {})
          });
          confirmedOrderId = params.orderId;
          confirmedSubscriptionId = params.subscriptionId;
          emit({ kind: "grantSettled", orderId: params.orderId, ok: true });
          return true;
        } catch (error) {
          grantFailure = {
            orderId: params.orderId,
            reason: `server grant callback failed: ${toIapErrorMessage(error)}`
          };
          emit({ kind: "grantSettled", orderId: params.orderId, ok: false });
          return false;
        }
      };

      const params = {
        options: {
          sku,
          ...(offerId !== undefined && offerId !== null ? { offerId } : {}),
          processProductGrant
        },
        onEvent: (event: { type: "success"; data: IapPurchaseSuccessInfo }) => {
          if (event.type === "success") {
            emit({ kind: "sdkSuccess", data: event.data });
          }
        },
        onError: (error: unknown) => {
          emit({ kind: "sdkError", error });
        }
      };

      return subscription
        ? platform.createSubscriptionPurchaseOrder(params)
        : platform.createOneTimePurchaseOrder(params);
    },
    reduce: (event) => {
      switch (event.kind) {
        case "sdkSuccess":
          stashedSuccess = event.data;
          return evaluate();
        case "grantSettled":
          return evaluate();
        case "sdkError": {
          if (grantFailure) {
            // The server grant failed first; that outcome wins over the
            // platform's error report.
            return evaluate();
          }
          const code = toIapErrorCode(event.error);
          if (code === "USER_CANCELED") {
            return { done: true, result: { status: "canceled" } };
          }
          return {
            done: true,
            result: {
              status: "failed",
              ...(code !== undefined ? { code } : {}),
              reason: toIapErrorMessage(event.error)
            }
          };
        }
      }
    }
  });
}
