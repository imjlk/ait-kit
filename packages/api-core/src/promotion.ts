import { requestToss } from "./mtls-client";
import {
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
  type PromotionRewardGrantInput,
  type PromotionRewardGrantResponse
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
  if (!promotionAmount) {
    return rewardFailure(request, "MISSING_TOSS_PROMOTION_AMOUNT", "amount is required for promotion grant");
  }

  let providerTransactionKey = stringOrUndefined(request.providerTransactionKey);
  if (!providerTransactionKey) {
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
