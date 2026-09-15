import { requestToss, resolveMtlsClient, resolveMtlsUrl } from "./mtls-client";
import { normalizeMessageRecipient, recipientIdentifierHeaders } from "./recipient";
import {
  AppsInTossApiError,
  clientError,
  httpStatusOk,
  isUpstreamFailure,
  numberOrUndefined,
  objectOrSelf,
  positiveIntegerOrUndefined,
  readPathValue,
  readPathString,
  stringOrUndefined,
  upstreamFailureCode,
  upstreamFailureReason
} from "./toss-envelope";
import {
  TOSS_ENDPOINTS,
  type NormalizedAppsInTossCoreOptions,
  type PromotionRewardExecuteInput,
  type PromotionRewardExecuteResponse,
  type PromotionRewardGrantInput,
  type PromotionRewardGrantResponse,
  type PromotionRewardPrepareInput,
  type PromotionRewardPrepareResponse,
  type PromotionRewardStatusInput,
  type PromotionRewardStatusResponse
} from "./types";

export async function grantPromotionReward(
  body: PromotionRewardGrantInput,
  options: NormalizedAppsInTossCoreOptions
): Promise<PromotionRewardGrantResponse> {
  const request = objectOrSelf(body, {});

  if (options.mode !== "forward") {
    return {
      ok: true,
      providerRequestId: stringOrUndefined(request.providerRequestId),
      providerStatus: "GRANTED",
      grantedAt: requestedAtOrNow(request.requestedAt, options.now),
      providerTransactionKey: stringOrUndefined(request.providerTransactionKey)
    };
  }

  const providerRequestId = stringOrUndefined(request.providerRequestId);
  const requestedAt = requestedAtOrNow(request.requestedAt, options.now);
  const tossUserKey = stringOrUndefined(request.tossUserKey);
  const promotionCode = stringOrUndefined(request.promotionCode) || options.tossPromotionCode;
  const promotionAmount =
    positiveIntegerOrUndefined(request.amount) ||
    positiveIntegerOrUndefined(request.promotionAmount) ||
    options.tossPromotionAmount;
  if (!tossUserKey) {
    return rewardFailure(request, "MISSING_TOSS_USER_KEY", "tossUserKey is required for promotion grant");
  }
  if (!promotionCode) {
    return rewardFailure(request, "MISSING_TOSS_PROMOTION_CODE", "promotionCode is required for promotion grant");
  }
  let providerTransactionKey = stringOrUndefined(request.providerTransactionKey);
  if (!providerTransactionKey) {
    if (!promotionAmount) {
      return rewardFailure(request, "MISSING_TOSS_PROMOTION_AMOUNT", "amount is required for promotion grant");
    }

    const keyResponse = await requestToss(
      { method: "POST", path: TOSS_ENDPOINTS.promotionGetKey, body: {}, tossUserKey },
      options
    );
    if (!httpStatusOk(keyResponse.status) || isUpstreamFailure(keyResponse.body)) {
      return rewardFailure(request, "PROMOTION_KEY_FAILED", upstreamFailureReason(keyResponse.body));
    }
    providerTransactionKey = readPathString(keyResponse.body, ["success.key", "key", "data.key"]);
    if (!providerTransactionKey) {
      return rewardFailure(request, "PROMOTION_KEY_MISSING", "Promotion get-key response did not include key");
    }

    const executeResponse = await requestToss(
      {
        method: "POST",
        path: TOSS_ENDPOINTS.promotionExecute,
        body: {
          promotionCode,
          key: providerTransactionKey,
          amount: promotionAmount
        },
        tossUserKey
      },
      options
    );
    const executeErrorCode = upstreamFailureCode(executeResponse.body);
    if (!httpStatusOk(executeResponse.status) || isUpstreamFailure(executeResponse.body)) {
      return rewardFailure(
        request,
        "PROMOTION_EXECUTE_FAILED",
        upstreamFailureReason(executeResponse.body),
        providerTransactionKey,
        executeErrorCode
      );
    }
  }

  const resultResponse = await requestToss(
    {
      method: "POST",
      path: TOSS_ENDPOINTS.promotionResult,
      body: { promotionCode, key: providerTransactionKey },
      tossUserKey
    },
    options
  );
  if (!httpStatusOk(resultResponse.status) || isUpstreamFailure(resultResponse.body)) {
    return {
      ok: true,
      providerRequestId,
      providerStatus: "PENDING",
      providerTransactionKey,
      failureReason: `Promotion result lookup failed: ${upstreamFailureReason(resultResponse.body)}`
    };
  }

  const providerStatus = normalizePromotionStatus(resultResponse.body);
  if (providerStatus === "FAILED") {
    return {
      ok: false,
      providerRequestId,
      providerStatus,
      providerTransactionKey,
      failureReason: upstreamFailureReason(resultResponse.body)
    };
  }

  return {
    ok: true,
    providerRequestId,
    providerStatus,
    providerTransactionKey,
    grantedAt: providerStatus === "GRANTED" ? requestedAt : undefined,
    failureReason: undefined
  };
}

function rewardFailure(
  request: Record<string, unknown>,
  providerStatus: string,
  failureReason: string,
  providerTransactionKey: string | undefined = undefined,
  providerErrorCode: string | undefined = undefined
): PromotionRewardGrantResponse {
  return {
    ok: false,
    providerRequestId: stringOrUndefined(request.providerRequestId),
    providerStatus,
    providerTransactionKey,
    providerErrorCode,
    failureReason
  };
}

/**
 * Prepare: issues a promotion transaction key (get-key) and nothing else.
 * The official endpoint takes no body and no recipient header. Consumers are
 * expected to persist the returned key before executing; see the promotion
 * section of the README for the recommended storage fields.
 */
export async function preparePromotionReward(
  _body: PromotionRewardPrepareInput,
  options: NormalizedAppsInTossCoreOptions
): Promise<PromotionRewardPrepareResponse> {
  if (options.mode !== "forward") {
    return { ok: true, providerTransactionKey: "stub-promotion-transaction-key", stub: true };
  }
  const keyResponse = await requestToss(
    // The official get-key contract takes no request body.
    { method: "POST", path: TOSS_ENDPOINTS.promotionGetKey },
    options
  );
  if (!httpStatusOk(keyResponse.status) || isUpstreamFailure(keyResponse.body)) {
    return {
      ok: false,
      providerStatus: "ERROR",
      failureReason: upstreamFailureReason(keyResponse.body),
      providerErrorCode: upstreamFailureCode(keyResponse.body),
      upstreamStatus: keyResponse.status
    };
  }
  const keyResultType = strictResultType(keyResponse.body);
  const rawKey = readPathValue(keyResponse.body, ["success.key", "key", "data.key"]);
  // Only an explicit SUCCESS envelope carrying a real string is provider
  // evidence; coerced arrays, numerics, or objects never become keys.
  if (keyResultType !== "SUCCESS" || typeof rawKey !== "string" || !rawKey.trim()) {
    return {
      ok: false,
      providerStatus: "ERROR",
      error: "INVALID_RESPONSE",
      failureReason:
        keyResultType === "SUCCESS"
          ? "Promotion get-key response did not include a string key"
          : "Promotion get-key response was not a SUCCESS envelope",
      upstreamStatus: keyResponse.status
    };
  }
  return { ok: true, providerTransactionKey: rawKey };
}

/**
 * Execute: requests the grant for an existing transaction key. Never issues
 * a new key — `providerTransactionKey` is required input. Transport failures
 * and unparseable responses return `result: "UNKNOWN"` with the key preserved
 * (the request may have been applied); resolve them with the status step
 * instead of re-executing.
 */
export async function executePromotionReward(
  body: PromotionRewardExecuteInput,
  options: NormalizedAppsInTossCoreOptions
): Promise<PromotionRewardExecuteResponse> {
  const request = objectOrSelf(body, {});
  const providerTransactionKey = requireTransactionKey(request, "execute a promotion");
  const promotionCode = resolvePromotionCode(request, options, "execute");
  const amount = resolvePromotionAmount(request, options, "execute");
  const recipient = normalizeMessageRecipient(request, "INVALID_PROMOTION_RECIPIENT", "promotion recipient");

  if (options.mode !== "forward") {
    return { ok: true, result: "SUBMITTED", providerTransactionKey, stub: true };
  }

  // Resolve the transport and URL before the dispatch window so configuration
  // and factory failures propagate: they happen before anything is sent and
  // must not masquerade as an uncertain outcome.
  const mtlsClient = await resolveMtlsClient(options);
  resolveMtlsUrl(TOSS_ENDPOINTS.promotionExecute, options);
  const dispatchOptions = { ...options, mtlsClient };

  let executeResponse;
  try {
    executeResponse = await requestToss(
      {
        method: "POST",
        path: TOSS_ENDPOINTS.promotionExecute,
        body: { promotionCode, key: providerTransactionKey, amount },
        headers: recipientIdentifierHeaders(recipient)
      },
      dispatchOptions
    );
  } catch (error) {
    // Kit-generated errors (missing mTLS client, invalid path) are thrown
    // before anything is dispatched — rethrow them instead of reporting an
    // outcome the request never had. Only genuine transport rejections are
    // uncertain: the grant request may have reached the provider.
    if (error instanceof AppsInTossApiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: true,
      result: "UNKNOWN",
      providerTransactionKey,
      failureReason: `promotion execute request failed: ${message}`
    };
  }

  if (!httpStatusOk(executeResponse.status) || isUpstreamFailure(executeResponse.body)) {
    // Strict scalar read: a malformed errorCode (arrays, objects) never
    // upgrades a payload into a coded, definite verdict.
    const providerErrorCode = strictUpstreamFailureCode(executeResponse.body);
    const definiteRejection =
      (httpStatusOk(executeResponse.status) &&
        strictResultType(executeResponse.body) === "FAIL" &&
        providerErrorCode !== undefined) ||
      (executeResponse.status >= 400 && executeResponse.status < 500);
    // A FAIL envelope with an error code (or a 4xx) is the provider's
    // explicit verdict for this call — including 4113 "already granted/
    // retracted", which callers should resolve through the status step
    // rather than by re-executing. 5xx, codeless, and malformed payloads
    // stay UNKNOWN: the request may or may not have been applied.
    if (definiteRejection) {
      return {
        ok: false,
        providerTransactionKey,
        providerStatus: "FAILED",
        failureReason: upstreamFailureReason(executeResponse.body),
        providerErrorCode,
        upstreamStatus: executeResponse.status
      };
    }
    return {
      ok: true,
      result: "UNKNOWN",
      providerTransactionKey,
      failureReason: upstreamFailureReason(executeResponse.body),
      upstreamStatus: executeResponse.status
    };
  }

  const executeResultType = strictResultType(executeResponse.body);
  if (executeResultType && executeResultType !== "SUCCESS") {
    return {
      ok: true,
      result: "UNKNOWN",
      providerTransactionKey,
      failureReason: `unexpected promotion execute envelope: ${executeResultType}`,
      upstreamStatus: executeResponse.status
    };
  }
  if (!executeResultType) {
    return {
      ok: true,
      result: "UNKNOWN",
      providerTransactionKey,
      failureReason: "promotion execute response was not a SUCCESS envelope",
      upstreamStatus: executeResponse.status
    };
  }
  return { ok: true, result: "SUBMITTED", providerTransactionKey };
}

/**
 * Status: reads the recorded outcome for an existing transaction key. Issues
 * no keys and executes no grants (zero get-key/execute calls). The official
 * API supplies no grant timestamp, so the response reports `checkedAt`
 * (observation time) instead of fabricating `grantedAt`.
 */
export async function statusPromotionReward(
  body: PromotionRewardStatusInput,
  options: NormalizedAppsInTossCoreOptions
): Promise<PromotionRewardStatusResponse> {
  const request = objectOrSelf(body, {});
  const providerTransactionKey = requireTransactionKey(request, "check promotion status");
  const promotionCode = resolvePromotionCode(request, options, "check promotion status");
  const recipient = normalizeMessageRecipient(request, "INVALID_PROMOTION_RECIPIENT", "promotion recipient");

  if (options.mode !== "forward") {
    // Stub never claims a grant: keep the observation pending and synthetic.
    return {
      ok: true,
      status: "PENDING",
      providerTransactionKey,
      checkedAt: options.now(),
      stub: true
    };
  }

  // Same pre-dispatch resolution as execute: factory/configuration failures
  // are never outcome-ambiguous.
  const mtlsClient = await resolveMtlsClient(options);
  resolveMtlsUrl(TOSS_ENDPOINTS.promotionResult, options);
  const dispatchOptions = { ...options, mtlsClient };

  let resultResponse;
  try {
    resultResponse = await requestToss(
      {
        method: "POST",
        path: TOSS_ENDPOINTS.promotionResult,
        body: { promotionCode, key: providerTransactionKey },
        headers: recipientIdentifierHeaders(recipient)
      },
      dispatchOptions
    );
  } catch (error) {
    // Kit-generated pre-dispatch errors (configuration, path) must surface,
    // not masquerade as an unverifiable outcome.
    if (error instanceof AppsInTossApiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return unknownStatus(providerTransactionKey, options, {
      failureReason: `promotion status request failed: ${message}`
    });
  }

  if (!httpStatusOk(resultResponse.status) || isUpstreamFailure(resultResponse.body)) {
    const providerErrorCode = strictUpstreamFailureCode(resultResponse.body);
    // Map 4111 only for an explicit provider verdict (2xx + resultType FAIL
    // with a scalar code): 5xx payloads that happen to carry the code, and
    // malformed envelopes, have an uncertain outcome.
    if (
      httpStatusOk(resultResponse.status) &&
      strictResultType(resultResponse.body) === "FAIL" &&
      providerErrorCode === "4111"
    ) {
      // Documented meaning: no grant record exists for this key.
      return {
        ok: true,
        status: "NOT_FOUND",
        providerTransactionKey,
        checkedAt: options.now(),
        providerErrorCode,
        failureReason: upstreamFailureReason(resultResponse.body),
        upstreamStatus: resultResponse.status
      };
    }
    return unknownStatus(providerTransactionKey, options, {
      failureReason: upstreamFailureReason(resultResponse.body),
      providerErrorCode,
      upstreamStatus: resultResponse.status
    });
  }

  // Only a verdict inside an explicit SUCCESS envelope counts; a 2xx payload
  // without one (or with an unrecognized resultType) stays UNKNOWN.
  const resultType = strictResultType(resultResponse.body);
  if (resultType !== "SUCCESS") {
    return unknownStatus(providerTransactionKey, options, {
      failureReason: resultType
        ? `unexpected promotion result envelope: ${resultType}`
        : "promotion status response was not a SUCCESS envelope",
      upstreamStatus: resultResponse.status
    });
  }

  const status = strictPromotionStatus(resultResponse.body);
  const checkedAt = options.now();
  if (status === "GRANTED" || status === "PENDING") {
    return { ok: true, status, providerTransactionKey, checkedAt };
  }
  if (status === "FAILED") {
    return {
      ok: true,
      status,
      providerTransactionKey,
      checkedAt,
      failureReason: upstreamFailureReason(resultResponse.body)
    };
  }
  return unknownStatus(providerTransactionKey, options, {
    failureReason: "promotion status response could not be interpreted",
    upstreamStatus: resultResponse.status
  });
}

/**
 * Strict mapping for the status step: only the documented provider enums
 * (`SUCCESS`, `PENDING`, `FAILED`) produce a verdict, and only from real
 * string evidence — coerced arrays or objects never count. Unlike the legacy
 * grant flow (which treats unrecognized values as FAILED and accepts extra
 * aliases), anything else returns undefined so the caller sees UNKNOWN.
 */
function strictPromotionStatus(value: unknown): "GRANTED" | "PENDING" | "FAILED" | undefined {
  const success = readPathValue(value, ["success"]);
  const raw =
    typeof success === "string"
      ? success
      : readPathValue(value, ["success.status", "status", "data.status", "data.success"]);
  if (typeof raw !== "string") return undefined;
  const status = raw.trim().toUpperCase();
  if (status === "SUCCESS") return "GRANTED";
  if (status === "PENDING") return "PENDING";
  if (status === "FAILED") return "FAILED";
  return undefined;
}

/**
 * Strict scalar error-code read for the explicit promotion steps: coerced
 * values like "[object Object]" never classify a response as a coded verdict.
 */
function strictUpstreamFailureCode(value: unknown): string | undefined {
  const raw = readPathValue(value, [
    "providerErrorCode",
    "errorCode",
    "code",
    "error.errorCode",
    "error.code",
    "success.errorCode",
    "data.errorCode",
    "data.code"
  ]);
  if (typeof raw === "string" && raw.trim()) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/** Strict resultType read: only a real string counts. */
function strictResultType(value: unknown): string {
  const raw = readPathValue(value, ["resultType", "success.resultType", "data.resultType"]);
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

/**
 * Resolves the promotion code for the explicit steps: a present-but-invalid
 * request value is rejected instead of being silently replaced by the
 * configured default, so the executed grant always matches what the caller
 * persisted for the key.
 */
function resolvePromotionCode(
  request: Record<string, unknown>,
  options: NormalizedAppsInTossCoreOptions,
  action: string
) {
  if (isPresent(request.promotionCode)) {
    // Strict string check: numeric or object values are rejected rather than
    // coerced, so the dispatched code always matches what the caller sent.
    if (typeof request.promotionCode !== "string" || !request.promotionCode.trim()) {
      throw clientError("INVALID_PROMOTION_CODE", `promotionCode must be a non-empty string to ${action}`);
    }
    return request.promotionCode;
  }
  if (options.tossPromotionCode !== undefined) {
    // The configured fallback obeys the same rules as request values.
    if (typeof options.tossPromotionCode !== "string" || !options.tossPromotionCode.trim()) {
      throw clientError(
        "INVALID_PROMOTION_CODE",
        `configured tossPromotionCode must be a non-empty string to ${action}`
      );
    }
    return options.tossPromotionCode;
  }
  throw clientError("MISSING_PROMOTION_CODE", `promotionCode is required to ${action}`);
}

/**
 * Resolves the grant amount for the execute step under the same rule: an
 * explicitly supplied invalid amount (non-number, zero, negative, fractional)
 * is rejected rather than swapped for the configured default. Coercible
 * values like "1000" or true are rejected too — the dispatched amount must
 * match the number the caller validated and persisted.
 */
function resolvePromotionAmount(
  request: Record<string, unknown>,
  options: NormalizedAppsInTossCoreOptions,
  action: string
) {
  const raw = request.amount ?? request.promotionAmount;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      throw clientError("INVALID_PROMOTION_AMOUNT", `amount must be a positive integer to ${action}`);
    }
    return raw;
  }
  if (options.tossPromotionAmount !== undefined) {
    const configured = options.tossPromotionAmount;
    // The configured fallback obeys the same constraints as request values:
    // Infinity serializes as null and negatives/fractions are invalid grants.
    if (typeof configured !== "number" || !Number.isInteger(configured) || configured <= 0) {
      throw clientError(
        "INVALID_PROMOTION_AMOUNT",
        `configured tossPromotionAmount must be a positive integer to ${action}`
      );
    }
    return configured;
  }
  throw clientError("MISSING_PROMOTION_AMOUNT", `amount is required to ${action}`);
}

/**
 * Requires the provider transaction key exactly as issued by prepare: a
 * strict non-empty string, so numeric or object values from untyped
 * boundaries are rejected instead of coerced into a different key.
 */
function requireTransactionKey(request: Record<string, unknown>, action: string) {
  const raw = request.providerTransactionKey;
  if (raw === undefined || raw === null) {
    throw clientError("MISSING_TRANSACTION_KEY", `providerTransactionKey is required to ${action}`);
  }
  if (typeof raw !== "string" || !raw.trim()) {
    throw clientError("INVALID_TRANSACTION_KEY", `providerTransactionKey must be a non-empty string to ${action}`);
  }
  return raw;
}

function isPresent(value: unknown) {
  return value !== undefined && value !== null;
}

function unknownStatus(
  providerTransactionKey: string,
  options: NormalizedAppsInTossCoreOptions,
  extra: { failureReason?: string; providerErrorCode?: string; upstreamStatus?: number }
): PromotionRewardStatusResponse {
  return {
    ok: true,
    status: "UNKNOWN",
    providerTransactionKey,
    checkedAt: options.now(),
    ...extra
  };
}

function normalizePromotionStatus(value: unknown) {
  const success = readPathValue(value, ["success"]);
  const status = String(
    (typeof success === "string" ? success : undefined) ||
      readPathString(value, [
        "success.status",
        "status",
        "data.status",
        "data.success",
        "success.resultType",
        "data.resultType",
        "resultType"
      ]) ||
      ""
  ).toUpperCase();
  if (["SUCCESS", "SUCCEEDED", "GRANTED", "DONE", "COMPLETED"].includes(status)) return "GRANTED";
  if (["PENDING", "WAITING", "PROCESSING"].includes(status)) return "PENDING";
  return "FAILED";
}

function requestedAtOrNow(value: unknown, now: () => number) {
  if (value === undefined || value === null) {
    return now();
  }
  return numberOrUndefined(value) ?? now();
}
