import { requestToss } from "./mtls-client";
import {
  debugLog,
  iapOrderStatusMaxAttempts,
  iapOrderStatusRetryDelayMs,
  isUpstreamFailure,
  objectOrSelf,
  readPathString,
  stringOrUndefined,
  upstreamFailureReason
} from "./toss-envelope";
import { TOSS_ENDPOINTS, type NormalizedAppsInTossCoreOptions } from "./types";

const RETRYABLE_IAP_ORDER_STATUSES = new Set([
  "NOT_FOUND",
  "ORDER_IN_PROGRESS",
  "PAYMENT_PENDING",
  "PENDING",
  "PROCESSING"
]);

export async function getIapOrderStatus(body: unknown, options: NormalizedAppsInTossCoreOptions) {
  if (options.mode !== "forward") {
    return stubIapOrderStatus(body);
  }

  const request = objectOrSelf(body, {});
  const orderId = stringOrUndefined(request.orderId);
  const tossUserKey = stringOrUndefined(request.tossUserKey);
  if (!orderId) {
    return { ok: false, error: "MISSING_ORDER_ID", providerStatus: "ERROR" };
  }
  if (!tossUserKey) {
    return { ok: false, error: "MISSING_TOSS_USER_KEY", providerStatus: "ERROR" };
  }

  const maxAttempts = iapOrderStatusMaxAttempts(options);
  const retryDelayMs = iapOrderStatusRetryDelayMs(options);
  let normalized;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const upstream = await requestToss(
      {
        method: "POST",
        path: TOSS_ENDPOINTS.iapOrderStatus,
        body: { orderId },
        tossUserKey
      },
      options
    );
    normalized = normalizeIapOrderStatusResponse(request, upstream.body);
    if (!isRetryableIapOrderStatus(normalized) || attempt >= maxAttempts) {
      return attempt > 1 ? { ...normalized, attempts: attempt } : normalized;
    }
    debugLog(options, "retrying transient iap order status", {
      orderId,
      providerStatus: objectOrSelf(normalized).providerStatus,
      attempt
    });
    if (retryDelayMs > 0) {
      await options.sleep(retryDelayMs);
    }
  }
  return normalized;
}

export function normalizeIapOrderStatusResponse(requestBody: unknown, upstream: unknown) {
  const request = objectOrSelf(requestBody, {});
  if (isUpstreamFailure(upstream)) {
    return {
      ok: false,
      orderId: request.orderId,
      providerStatus: "ERROR",
      failureReason: upstreamFailureReason(upstream)
    };
  }

  const order = objectOrSelf(readOrderValue(upstream), objectOrSelf(upstream, {}));
  const providerStatus = readPathString(order, ["status", "success.status", "data.status"]) || "ERROR";
  return {
    ok: true,
    orderId: readPathString(order, ["orderId", "success.orderId", "data.orderId"]) ?? request.orderId,
    sku: readPathString(order, ["sku", "success.sku", "data.sku"]) ?? stringOrUndefined(request.sku),
    providerStatus,
    statusDeterminedAt: readPathString(order, [
      "statusDeterminedAt",
      "success.statusDeterminedAt",
      "data.statusDeterminedAt"
    ]),
    reason: readPathString(order, ["reason", "success.reason", "data.reason"])
  };
}

function stubIapOrderStatus(body: unknown) {
  const request = objectOrSelf(body, {});
  return {
    ok: true,
    orderId: String(request.orderId || ""),
    sku: String(request.sku || ""),
    providerStatus: "PAYMENT_COMPLETED",
    statusDeterminedAt: new Date(0).toISOString(),
    reason: "stub iap order status"
  };
}

function readOrderValue(upstream: unknown) {
  const object = objectOrSelf(upstream, {});
  return object.success ?? object.data ?? object.result;
}

function isRetryableIapOrderStatus(result: unknown) {
  const object = objectOrSelf(result, {});
  if (!object.ok) return false;
  return RETRYABLE_IAP_ORDER_STATUSES.has(String(object.providerStatus || "").trim().toUpperCase());
}

