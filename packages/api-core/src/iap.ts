import { requestToss } from "./mtls-client.js";
import {
  debugLog,
  httpStatusOk,
  iapOrderStatusMaxAttempts,
  iapOrderStatusRetryDelayMs,
  objectOrSelf,
  readStrictStringState,
  stringOrUndefined,
  upstreamFailureCode,
  upstreamFailureReason
} from "./toss-envelope.js";
import {
  TOSS_ENDPOINTS,
  type IapOrderStatusInput,
  type IapOrderStatusResponse,
  type IapOrderUnverifiedResponse,
  type IapOrderVerifiedResponse,
  type IapVerificationCode,
  type NormalizedAppsInTossCoreOptions
} from "./types.js";

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

/**
 * Envelope resultTypes that mean the provider explicitly did not produce
 * order evidence for this query. A `success` payload riding along one of
 * these envelopes is contradictory and is never used as evidence.
 */
const IAP_QUERY_FAILURE_RESULT_TYPES = new Set(["FAIL", "FAILED", "ERROR", "NETWORK_ERROR", "TIMEOUT"]);

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
 *
 * Evidence is read strictly: required fields (`orderId`, `status`) and any
 * present optional field (`sku`, `statusDeterminedAt`, `reason`) must be
 * real strings — a single-element array, object, number, or boolean is an
 * INVALID_RESPONSE, never a stringified stand-in. Envelopes that report a
 * query failure (`FAIL`, `ERROR`, `NETWORK_ERROR`, …) yield no evidence
 * even when a contradictory `success` payload rides along.
 */
export function normalizeIapOrderStatusResponse(
  requestBody: IapOrderStatusInput,
  upstream: unknown,
  upstreamStatus = 200
): IapOrderStatusResponse {
  const request = objectOrSelf(requestBody, {});
  if (!httpStatusOk(upstreamStatus)) {
    return {
      ok: false,
      orderId: stringOrUndefined(request.orderId),
      providerStatus: "ERROR",
      failureReason: upstreamFailureReason(upstream),
      upstreamStatus
    };
  }

  const upstreamObject = objectOrSelf(upstream, {});

  // An explicit ok:false is a stated failure: it always wins over any
  // resultType or success payload riding along (a SUCCESS envelope with
  // ok:false is contradictory, not evidence).
  if (upstreamObject.ok === false) {
    return {
      ok: false,
      orderId: stringOrUndefined(request.orderId),
      providerStatus: "ERROR",
      failureReason: upstreamFailureReason(upstream),
      providerErrorCode: upstreamFailureCode(upstream),
      upstreamStatus
    };
  }

  // The envelope resultType is classified strictly (a real string only)
  // across EVERY alias: a present alias with the wrong type, or aliases
  // that disagree (top-level SUCCESS with a nested FAIL), is invalid —
  // the first-present value never hides a stated failure. Recognized
  // failure envelopes end the query without evidence; unknown resultTypes
  // are uninterpretable, not optimistic successes.
  const envelopeResultType = readUniqueStrictString(upstream, [
    "resultType",
    "success.resultType",
    "data.resultType",
    "result.resultType"
  ]);
  if (envelopeResultType.state === "invalid") {
    return invalidIapResponse(request, envelopeResultType.reason, upstreamStatus);
  }
  if (envelopeResultType.state === "present") {
    if (IAP_QUERY_FAILURE_RESULT_TYPES.has(envelopeResultType.value.trim().toUpperCase())) {
      return {
        ok: false,
        orderId: stringOrUndefined(request.orderId),
        providerStatus: "ERROR",
        failureReason: upstreamFailureReason(upstream),
        providerErrorCode: upstreamFailureCode(upstream),
        upstreamStatus
      };
    }
    if (envelopeResultType.value.trim().toUpperCase() !== "SUCCESS") {
      return invalidIapResponse(
        request,
        `unrecognized resultType for order status: ${envelopeResultType.value}`,
        upstreamStatus
      );
    }
  }

  // With a SUCCESS envelope, evidence lives in the nested success/data/
  // result object only — a malformed or absent nested payload is an
  // INVALID_RESPONSE and must never fall back to envelope-level fields
  // (which would let a contradictory envelope verify itself). Only the
  // envelope-free legacy shape reads the order directly from the top level.
  const orderValue = readOrderValue(upstream);
  let order: Record<string, unknown>;
  if (envelopeResultType.state === "present") {
    if (orderValue === undefined || orderValue === null) {
      return invalidIapResponse(request, "success payload is missing the required orderId", upstreamStatus);
    }
    if (typeof orderValue !== "object" || Array.isArray(orderValue)) {
      return invalidIapResponse(request, "success payload was not an object", upstreamStatus);
    }
    order = orderValue as Record<string, unknown>;
  } else {
    order = objectOrSelf(orderValue, upstreamObject);
  }

  const providerOrderIdState = readStrictStringState(order, ["orderId", "success.orderId", "data.orderId"]);
  if (providerOrderIdState.state === "absent") {
    return invalidIapResponse(request, "success payload is missing the required orderId", upstreamStatus);
  }
  if (providerOrderIdState.state === "invalid") {
    return invalidIapResponse(request, "success payload carried an orderId that was not a string", upstreamStatus);
  }
  const providerOrderId = providerOrderIdState.value;

  const providerStatusState = readStrictStringState(order, ["status", "success.status", "data.status"]);
  if (providerStatusState.state === "absent") {
    return invalidIapResponse(request, "success payload is missing the required status", upstreamStatus);
  }
  if (providerStatusState.state === "invalid") {
    return invalidIapResponse(request, "success payload carried a status that was not a string", upstreamStatus);
  }
  // The status is a provider enum, not an identifier: normalize it as
  // before so padded values still classify. Only identifiers (orderId,
  // sku) keep the provider's exact bytes.
  const providerStatus = providerStatusState.value.trim().toUpperCase();

  // Optional evidence fields: absence is documented for some statuses
  // (MINIAPP_MISMATCH, NOT_FOUND, ERROR), but a present value with the
  // wrong type makes the whole payload untrustworthy.
  const optionalEvidence: Array<[name: string, state: ReturnType<typeof readStrictStringState>]> = [
    ["sku", readStrictStringState(order, ["sku", "success.sku", "data.sku"])],
    ["statusDeterminedAt", readStrictStringState(order, ["statusDeterminedAt", "success.statusDeterminedAt", "data.statusDeterminedAt"])],
    ["reason", readStrictStringState(order, ["reason", "success.reason", "data.reason"])]
  ];
  for (const [name, state] of optionalEvidence) {
    if (state.state === "invalid") {
      return invalidIapResponse(request, `success payload carried a ${name} that was not a string`, upstreamStatus);
    }
  }
  const providerSku = optionalEvidence[0][1].state === "present" ? optionalEvidence[0][1].value : undefined;
  const statusDeterminedAt =
    optionalEvidence[1][1].state === "present" ? optionalEvidence[1][1].value : undefined;
  const reason = optionalEvidence[2][1].state === "present" ? optionalEvidence[2][1].value : undefined;

  // Verification ties the provider payload to the caller's expectation; a
  // missing requested order ID cannot confirm anything (defensive for direct
  // normalizeIapOrderStatusResponse callers — the forward path validates it).
  const requestedOrderId = stringOrUndefined(request.orderId);
  if (!requestedOrderId) {
    return {
      ok: false,
      orderId: providerOrderId,
      providerStatus: "ERROR",
      error: "MISSING_ORDER_ID",
      failureReason: "order status verification requires a requested orderId",
      upstreamStatus
    };
  }

  const expectedSku = stringOrUndefined(request.sku);

  const orderIdMatches = providerOrderId === requestedOrderId;
  const payable = PAYABLE_IAP_ORDER_STATUSES.has(providerStatus);

  const shared = {
    ok: true as const,
    orderId: providerOrderId,
    providerStatus,
    statusDeterminedAt,
    reason
  };

  if (payable && orderIdMatches) {
    const response: IapOrderVerifiedResponse = { ...shared, verified: true };
    if (providerSku !== undefined) response.sku = providerSku;
    const check = skuCheck(providerSku, expectedSku);
    if (check) response.skuCheck = check;
    return response;
  }

  const response: IapOrderUnverifiedResponse = {
    ...shared,
    verified: false,
    verificationCode: orderIdMatches
      ? (VERIFICATION_CODES_BY_PROVIDER_STATUS[providerStatus] ?? "UNKNOWN_STATUS")
      : "ORDER_ID_MISMATCH"
  };
  if (providerSku !== undefined) response.sku = providerSku;
  const check = skuCheck(providerSku, expectedSku);
  if (check) response.skuCheck = check;
  return response;
}


/**
 * Reads one logical value across several aliases strictly: every present
 * alias must be a real string, and present aliases must agree after enum
 * normalization (trim + case). The returned present value keeps the first
 * alias's original bytes for surfacing; disagreements are invalid.
 */
function readUniqueStrictString(
  value: unknown,
  paths: string[]
): { state: "present"; value: string } | { state: "absent" } | { state: "invalid"; reason: string } {
  const reads = paths.map((p) => readStrictStringState(value, [p]));
  for (const read of reads) {
    if (read.state === "invalid") {
      return { state: "invalid", reason: `${paths[reads.indexOf(read)]} was not a string` };
    }
  }
  const present = reads.filter((read): read is { state: "present"; value: string } => read.state === "present");
  if (present.length === 0) return { state: "absent" };
  const normalized = new Set(present.map((read) => read.value.trim().toUpperCase()));
  if (normalized.size > 1) {
    return { state: "invalid", reason: "conflicting resultType aliases" };
  }
  return { state: "present", value: present[0].value };
}

function invalidIapResponse(
  request: Record<string, unknown>,
  failureReason: string,
  upstreamStatus: number
): IapOrderStatusResponse {
  return {
    ok: false,
    orderId: stringOrUndefined(request.orderId),
    providerStatus: "ERROR",
    error: "INVALID_RESPONSE",
    failureReason,
    upstreamStatus
  };
}

function skuCheck(
  providerSku: string | undefined,
  expectedSku: string | undefined
): IapOrderVerifiedResponse["skuCheck"] {
  if (expectedSku === undefined) return undefined;
  if (providerSku === undefined) return { status: "NOT_PROVIDED" };
  return { status: providerSku === expectedSku ? "MATCHED" : "MISMATCHED", providerSku };
}

function stubIapOrderStatus(body: IapOrderStatusInput): IapOrderStatusResponse {
  const request = objectOrSelf(body, {});
  const orderId = stringOrUndefined(request.orderId);
  if (!orderId) {
    return { ok: false, error: "MISSING_ORDER_ID", providerStatus: "ERROR" };
  }
  // Synthetic development data: never verified, so an omitted mode setting can
  // never turn fabricated orders into grantable ones. Development flows that
  // want to exercise grant logic must opt in by checking `stub: true`.
  const expectedSku = stringOrUndefined(request.sku);
  const response: IapOrderUnverifiedResponse = {
    ok: true,
    verified: false,
    verificationCode: "STUB_EVIDENCE",
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
