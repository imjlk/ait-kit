import { requestToss } from "./mtls-client";
import {
  isUpstreamFailure,
  numberOrUndefined,
  objectOrSelf,
  positiveIntegerOrUndefined,
  readPathString,
  stringOrUndefined,
  upstreamFailureCode,
  upstreamFailureReason
} from "./toss-envelope";
import { TOSS_ENDPOINTS, type NormalizedAppsInTossCoreOptions } from "./types";

export async function grantPromotionReward(body: unknown, options: NormalizedAppsInTossCoreOptions) {
  const request = objectOrSelf(body, {});

  if (options.mode !== "forward") {
    return {
      ok: true,
      providerRequestId: request.providerRequestId,
      providerStatus: "GRANTED",
      grantedAt: request.requestedAt ?? options.now(),
      providerTransactionKey: request.providerTransactionKey
    };
  }

  const providerRequestId = stringOrUndefined(request.providerRequestId);
  const requestedAt = numberOrUndefined(request.requestedAt) ?? options.now();
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
    const keyResponse = await requestToss(
      { method: "POST", path: TOSS_ENDPOINTS.promotionGetKey, body: {}, tossUserKey },
      options
    );
    if (isUpstreamFailure(keyResponse.body)) {
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
    if (isUpstreamFailure(executeResponse.body)) {
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
  if (isUpstreamFailure(resultResponse.body)) {
    return {
      ok: true,
      providerRequestId,
      providerStatus: "PENDING",
      providerTransactionKey,
      failureReason: `Promotion result lookup failed: ${upstreamFailureReason(resultResponse.body)}`
    };
  }

  const providerStatus = normalizePromotionStatus(resultResponse.body);
  return {
    ok: providerStatus !== "FAILED",
    providerRequestId,
    providerStatus,
    providerTransactionKey,
    grantedAt: providerStatus === "GRANTED" ? requestedAt : undefined,
    failureReason: providerStatus === "FAILED" ? upstreamFailureReason(resultResponse.body) : undefined
  };
}

function rewardFailure(
  request: Record<string, unknown>,
  providerStatus: string,
  failureReason: string,
  providerTransactionKey: string | undefined = undefined,
  providerErrorCode: string | undefined = undefined
) {
  return {
    ok: false,
    providerRequestId: request.providerRequestId,
    providerStatus,
    providerTransactionKey,
    providerErrorCode,
    failureReason
  };
}

function normalizePromotionStatus(value: unknown) {
  const status = String(
    readPathString(value, [
      "success.status",
      "status",
      "data.status",
      "resultType",
      "success.resultType",
      "data.resultType"
    ]) || ""
  ).toUpperCase();
  if (["SUCCESS", "SUCCEEDED", "GRANTED", "DONE", "COMPLETED"].includes(status)) return "GRANTED";
  if (["PENDING", "WAITING", "PROCESSING"].includes(status)) return "PENDING";
  return "FAILED";
}

