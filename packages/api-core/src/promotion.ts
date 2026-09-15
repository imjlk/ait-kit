import { requestToss } from "./mtls-client";
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
  const providerTransactionKey = readPathString(keyResponse.body, ["success.key", "key", "data.key"]);
  if (!providerTransactionKey) {
    return {
      ok: false,
      providerStatus: "ERROR",
      error: "PROMOTION_KEY_MISSING",
      failureReason: "Promotion get-key response did not include key",
      upstreamStatus: keyResponse.status
    };
  }
  return { ok: true, providerTransactionKey };
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
  const providerTransactionKey = stringOrUndefined(request.providerTransactionKey);
  if (!providerTransactionKey) {
    throw clientError("MISSING_TRANSACTION_KEY", "providerTransactionKey is required to execute a promotion");
  }
  const promotionCode = resolvePromotionCode(request, options, "execute");
  const amount = resolvePromotionAmount(request, options, "execute");
  const recipient = normalizeMessageRecipient(request, "INVALID_PROMOTION_RECIPIENT", "promotion recipient");

  if (options.mode !== "forward") {
    return { ok: true, result: "SUBMITTED", providerTransactionKey, stub: true };
  }

  let executeResponse;
  try {
    executeResponse = await requestToss(
      {
        method: "POST",
        path: TOSS_ENDPOINTS.promotionExecute,
        body: { promotionCode, key: providerTransactionKey, amount },
        headers: recipientIdentifierHeaders(recipient)
      },
      options
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
    const providerErrorCode = upstreamFailureCode(executeResponse.body);
    const definiteRejection =
      (httpStatusOk(executeResponse.status) && isUpstreamFailure(executeResponse.body) && providerErrorCode !== undefined) ||
      (executeResponse.status >= 400 && executeResponse.status < 500);
    // A FAIL envelope with an error code (or a 4xx) is the provider's
    // explicit verdict for this call — including 4113 "already granted/
    // retracted", which callers should resolve through the status step
    // rather than by re-executing. 5xx and codeless payloads stay UNKNOWN:
    // the request may or may not have been applied.
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

  const resultType = String(
    readPathString(executeResponse.body, ["resultType", "success.resultType", "data.resultType"]) ?? ""
  ).toUpperCase();
  if (resultType && resultType !== "SUCCESS") {
    return {
      ok: true,
      result: "UNKNOWN",
      providerTransactionKey,
      failureReason: `unexpected promotion execute envelope: ${resultType}`,
      upstreamStatus: executeResponse.status
    };
  }
  if (!resultType) {
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
  const providerTransactionKey = stringOrUndefined(request.providerTransactionKey);
  if (!providerTransactionKey) {
    throw clientError("MISSING_TRANSACTION_KEY", "providerTransactionKey is required to check promotion status");
  }
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

  let resultResponse;
  try {
    resultResponse = await requestToss(
      {
        method: "POST",
        path: TOSS_ENDPOINTS.promotionResult,
        body: { promotionCode, key: providerTransactionKey },
        headers: recipientIdentifierHeaders(recipient)
      },
      options
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
    const providerErrorCode = upstreamFailureCode(resultResponse.body);
    // Map 4111 only for an expected provider verdict (2xx + FAIL envelope):
    // a 5xx that happens to carry the code has an uncertain outcome.
    if (httpStatusOk(resultResponse.status) && isUpstreamFailure(resultResponse.body) && providerErrorCode === "4111") {
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
 * (`SUCCESS`, `PENDING`, `FAILED`) produce a verdict. Unlike the legacy
 * grant flow (which treats unrecognized values as FAILED and accepts extra
 * aliases), anything else returns undefined so the caller sees UNKNOWN.
 */
function strictPromotionStatus(value: unknown): "GRANTED" | "PENDING" | "FAILED" | undefined {
  const success = readPathValue(value, ["success"]);
  const raw =
    (typeof success === "string" ? success : undefined) ||
    readPathString(value, ["success.status", "status", "data.status", "data.success"]) ||
    "";
  const status = raw.trim().toUpperCase();
  if (status === "SUCCESS") return "GRANTED";
  if (status === "PENDING") return "PENDING";
  if (status === "FAILED") return "FAILED";
  return undefined;
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
    const code = stringOrUndefined(request.promotionCode);
    if (!code) {
      throw clientError("INVALID_PROMOTION_CODE", `promotionCode must be a non-empty string to ${action}`);
    }
    return code;
  }
  if (options.tossPromotionCode) return options.tossPromotionCode;
  throw clientError("MISSING_PROMOTION_CODE", `promotionCode is required to ${action}`);
}

/**
 * Resolves the grant amount for the execute step under the same rule: an
 * explicitly supplied invalid amount (zero, negative, fractional) is
 * rejected rather than swapped for the configured default.
 */
function resolvePromotionAmount(
  request: Record<string, unknown>,
  options: NormalizedAppsInTossCoreOptions,
  action: string
) {
  const raw = request.amount ?? request.promotionAmount;
  if (raw !== undefined && raw !== null) {
    const amount = positiveIntegerOrUndefined(raw);
    if (!amount) {
      throw clientError("INVALID_PROMOTION_AMOUNT", `amount must be a positive integer to ${action}`);
    }
    return amount;
  }
  if (options.tossPromotionAmount) return options.tossPromotionAmount;
  throw clientError("MISSING_PROMOTION_AMOUNT", `amount is required to ${action}`);
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
