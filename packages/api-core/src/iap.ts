import { requestToss } from "./mtls-client";
import {
  debugLog,
  httpStatusOk,
  iapOrderStatusMaxAttempts,
  iapOrderStatusRetryDelayMs,
  isUpstreamFailure,
  objectOrSelf,
  readPathString,
  stringOrUndefined,
  upstreamFailureReason
} from "./toss-envelope";
import {
  TOSS_ENDPOINTS,
  type IapOrderStatusInput,
  type IapOrderStatusResponse,
  type IapVerificationCode,
  type NormalizedAppsInTossCoreOptions
} from "./types";

const RETRYABLE_IAP_ORDER_STATUSES = new Set([
  "NOT_FOUND",
  "ORDER_IN_PROGRESS",
  "PAYMENT_PENDING",
  "PENDING",
  "PROCESSING"
]);

const PAYABLE_IAP_ORDER_STATUSES = new Set(["PAYMENT_COMPLETED", "PURCHASED"]);

const VERIFICATION_CODES_BY_PROVIDER_STATUS: Record<string, IapVerificationCode> = {
  FAILED: "PAYMENT_FAILED",
  MINIAPP_MISMATCH: "MINIAPP_MISMATCH",
  NOT_FOUND: "ORDER_NOT_FOUND",
  ORDER_IN_PROGRESS: "PAYMENT_INCOMPLETE",
  PAYMENT_PENDING: "PAYMENT_INCOMPLETE",
  PENDING: "PAYMENT_INCOMPLETE",
  PROCESSING: "PAYMENT_INCOMPLETE",
  REFUNDED: "PAYMENT_REFUNDED",
  ERROR: "PROVIDER_STATUS_ERROR"
};

export async function getIapOrderStatus(
  body: IapOrderStatusInput,
  options: NormalizedAppsInTossCoreOptions
): Promise<IapOrderStatusResponse> {
  if (options.mode !== "forward") {
    return stubIapOrderStatus(body);
  }

  const request = objectOrSelf(body, {});
  const orderId = stringOrUndefined(request.orderId);
  const tossUserKey = stringOrUndefined(request.tossUserKey);
  if (!orderId) {
    return { ok: false, error: "MISSING_ORDER_ID", providerStatus: "ERROR" };
  }
  const maxAttempts = iapOrderStatusMaxAttempts(options);
  const retryDelayMs = iapOrderStatusRetryDelayMs(options);
  let normalized: IapOrderStatusResponse | undefined;
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
    normalized = normalizeIapOrderStatusResponse(request, upstream.body, upstream.status);
    if (!isRetryableIapOrderStatus(normalized) || attempt >= maxAttempts) {
      return attempt > 1 && normalized.ok ? { ...normalized, attempts: attempt } : normalized;
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
  return normalized ?? { ok: false, providerStatus: "ERROR", failureReason: "IAP order status was not checked" };
}

/**
 * Normalizes a provider `get-order-status` answer into the verification
 * contract: request expectations (`orderId`, `sku`) are only ever compared
 * against provider-returned evidence, never used to fill evidence gaps.
 */
export function normalizeIapOrderStatusResponse(
  requestBody: IapOrderStatusInput,
  upstream: unknown,
  upstreamStatus = 200
): IapOrderStatusResponse {
  const request = objectOrSelf(requestBody, {});
  if (!httpStatusOk(upstreamStatus) || isUpstreamFailure(upstream)) {
    return {
      ok: false,
      orderId: stringOrUndefined(request.orderId),
      providerStatus: "ERROR",
      failureReason: upstreamFailureReason(upstream),
      upstreamStatus
    };
  }

  const order = objectOrSelf(readOrderValue(upstream), objectOrSelf(upstream, {}));
  const providerOrderId = readPathString(order, ["orderId", "success.orderId", "data.orderId"]);
  if (!providerOrderId) {
    return {
      ok: false,
      orderId: stringOrUndefined(request.orderId),
      providerStatus: "ERROR",
      error: "INVALID_RESPONSE",
      failureReason: "success payload is missing the required orderId",
      upstreamStatus
    };
  }
  const providerStatus =
    readPathString(order, ["status", "success.status", "data.status"])?.trim().toUpperCase() || "";
  if (!providerStatus) {
    return {
      ok: false,
      orderId: providerOrderId,
      providerStatus: "ERROR",
      error: "INVALID_RESPONSE",
      failureReason: "success payload is missing the required status",
      upstreamStatus
    };
  }

  // SKU evidence comes from the provider response only; it is optional per the
  // official API and its absence never flips `verified` on a payable status.
  const providerSku = readPathString(order, ["sku", "success.sku", "data.sku"]);
  const expectedSku = stringOrUndefined(request.sku);

  const requestedOrderId = stringOrUndefined(request.orderId);
  const orderIdMatches = requestedOrderId === undefined || providerOrderId === requestedOrderId;
  const payable = PAYABLE_IAP_ORDER_STATUSES.has(providerStatus);
  const verified = payable && orderIdMatches;

  const response: Extract<IapOrderStatusResponse, { ok: true }> = {
    ok: true,
    verified,
    orderId: providerOrderId,
    providerStatus,
    statusDeterminedAt: readPathString(order, [
      "statusDeterminedAt",
      "success.statusDeterminedAt",
      "data.statusDeterminedAt"
    ]),
    reason: readPathString(order, ["reason", "success.reason", "data.reason"])
  };
  if (providerSku !== undefined) {
    response.sku = providerSku;
  }
  if (!verified) {
    response.verificationCode = orderIdMatches
      ? (VERIFICATION_CODES_BY_PROVIDER_STATUS[providerStatus] ?? "UNKNOWN_STATUS")
      : "ORDER_ID_MISMATCH";
  }
  if (expectedSku !== undefined) {
    response.skuCheck =
      providerSku === undefined
        ? { status: "NOT_PROVIDED" }
        : { status: providerSku === expectedSku ? "MATCHED" : "MISMATCHED", providerSku };
  }
  return response;
}

function stubIapOrderStatus(body: IapOrderStatusInput): IapOrderStatusResponse {
  const request = objectOrSelf(body, {});
  const orderId = stringOrUndefined(request.orderId);
  if (!orderId) {
    return { ok: false, error: "MISSING_ORDER_ID", providerStatus: "ERROR" };
  }
  // Synthetic development data. The stub marker keeps this output from being
  // mistaken for provider verification evidence.
  const expectedSku = stringOrUndefined(request.sku);
  const response: Extract<IapOrderStatusResponse, { ok: true }> = {
    ok: true,
    verified: true,
    orderId,
    providerStatus: "PAYMENT_COMPLETED",
    statusDeterminedAt: new Date(0).toISOString(),
    reason: "stub iap order status",
    stub: true
  };
  if (expectedSku !== undefined) {
    response.sku = expectedSku;
    response.skuCheck = { status: "MATCHED", providerSku: expectedSku };
  }
  return response;
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
