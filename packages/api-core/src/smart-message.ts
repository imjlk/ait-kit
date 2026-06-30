import { requestToss } from "./mtls-client";
import {
  clientError,
  httpStatusOk,
  isUpstreamFailure,
  nonNegativeIntegerOrUndefined,
  objectOrSelf,
  readPathString,
  readPathValue,
  stringOrUndefined,
  upstreamFailureCode,
  upstreamFailureReason
} from "./toss-envelope";
import { SMART_MESSAGE_BULK_MAX_CONTEXTS, TOSS_ENDPOINTS, type NormalizedAppsInTossCoreOptions } from "./types";

export async function sendSmartMessage(body: unknown, options: NormalizedAppsInTossCoreOptions) {
  const request = objectOrSelf(body, {});
  if (options.mode !== "forward") {
    return stubSmartMessageResponse(request, 1, options.now);
  }
  const upstream = await requestToss(
    {
      method: "POST",
      path: TOSS_ENDPOINTS.messageSend,
      body: messageUpstreamBody(request),
      tossUserKey: stringOrUndefined(request.tossUserKey)
    },
    options
  );
  return normalizeMessageResponse(request, upstream.body, upstream.status, options.now);
}

export async function bulkSendSmartMessage(body: unknown, options: NormalizedAppsInTossCoreOptions) {
  const request = objectOrSelf(body, {});
  const upstreamBody = bulkMessageUpstreamBody(request);
  if (options.mode !== "forward") {
    return stubSmartMessageResponse(request, upstreamBody.contextList.length, options.now);
  }
  const upstream = await requestToss(
    {
      method: "POST",
      path: TOSS_ENDPOINTS.messageBulkSend,
      body: upstreamBody
    },
    options
  );
  return normalizeMessageResponse(request, upstream.body, upstream.status, options.now);
}

export function messageUpstreamBody(body: Record<string, unknown>) {
  const templateSetCode = resolveTemplateSetCode(body);
  if (!templateSetCode) {
    throw clientError("MISSING_TEMPLATE_SET_CODE", "templateSetCode is required");
  }
  return {
    templateSetCode,
    context: messageContext(body.context, "context")
  };
}

export function bulkMessageUpstreamBody(body: Record<string, unknown>) {
  const templateSetCode = resolveTemplateSetCode(body);
  if (!templateSetCode) {
    throw clientError("MISSING_TEMPLATE_SET_CODE", "templateSetCode is required");
  }
  if (!Array.isArray(body.contextList)) {
    throw clientError("INVALID_CONTEXT_LIST", "contextList must be an array");
  }
  if (body.contextList.length < 1) {
    throw clientError("EMPTY_CONTEXT_LIST", "contextList must include at least one recipient");
  }
  if (body.contextList.length > SMART_MESSAGE_BULK_MAX_CONTEXTS) {
    throw clientError("CONTEXT_LIST_TOO_LARGE", "contextList supports at most 2500 recipients", 413);
  }
  return {
    templateSetCode,
    contextList: body.contextList.map((entry, index) => {
      const item = objectOrSelf(entry, {});
      const userKey = stringOrUndefined(item.userKey ?? item.tossUserKey);
      if (!userKey) {
        throw clientError("MISSING_CONTEXT_USER_KEY", `contextList[${index}].userKey is required`);
      }
      return {
        userKey,
        context: messageContext(item.context, `contextList[${index}].context`)
      };
    })
  };
}

export function normalizeMessageResponse(
  requestBody: Record<string, unknown>,
  upstream: unknown,
  upstreamStatus = 200,
  now: () => number = Date.now
) {
  const upstreamObject = objectOrSelf(upstream, {});
  const resultType = readPathString(upstreamObject, ["resultType", "success.resultType", "data.resultType"]);
  const providerRequestId =
    readPathString(upstreamObject, ["providerRequestId", "requestId", "result.providerRequestId"]) ??
    requestBody.providerRequestId;
  const sentAt = upstreamObject.sentAt ?? requestBody.requestedAt ?? now();

  if (!httpStatusOk(upstreamStatus)) {
    return {
      ok: false,
      providerRequestId,
      providerStatus: "FAILED",
      resultType,
      sentAt,
      failureReason: upstreamFailureReason(upstreamObject),
      providerErrorCode: upstreamFailureCode(upstreamObject),
      upstreamStatus
    };
  }

  if (upstreamObject.providerStatus || (upstreamObject.status && !upstreamObject.resultType && !upstreamObject.result)) {
    const providerStatus = upstreamObject.providerStatus ?? upstreamObject.status;
    return {
      ok: upstreamObject.ok ?? messageStatusOk(providerStatus),
      providerRequestId: upstreamObject.providerRequestId ?? requestBody.providerRequestId,
      providerStatus,
      sentAt: upstreamObject.sentAt,
      failureReason: upstreamObject.failureReason ?? upstreamObject.errorMessage ?? upstreamObject.message
    };
  }

  const result = objectOrSelf(
    readPathValue(upstreamObject, ["result", "success.result", "success", "data.result", "data.success"]),
    {}
  );

  if (isUpstreamFailure(upstreamObject)) {
    return {
      ok: false,
      providerRequestId,
      providerStatus: "FAILED",
      resultType,
      sentAt,
      failureReason: upstreamFailureReason(upstreamObject),
      providerErrorCode: upstreamFailureCode(upstreamObject)
    };
  }

  const msgCount = nonNegativeIntegerOrUndefined(readPathValue(result, ["msgCount"]));
  const sentPushCount = nonNegativeIntegerOrUndefined(readPathValue(result, ["sentPushCount"]));
  const sentInboxCount = nonNegativeIntegerOrUndefined(readPathValue(result, ["sentInboxCount"]));
  const failures = collectMessageFailures(result);
  const contentIds = collectMessageContentIds(objectOrSelf(result, {}).detail);
  const sentCount = [msgCount, sentPushCount, sentInboxCount]
    .filter((value) => value !== undefined)
    .reduce((a, b) => Number(a) + Number(b), 0);
  const failureReason = firstMessageFailureReason(failures);
  const providerStatus = sentCount > 0 || failures.length === 0 ? "SENT" : "FAILED";

  return {
    ok: providerStatus === "SENT",
    providerRequestId,
    providerStatus,
    resultType,
    sentAt,
    failureReason,
    msgCount: msgCount ?? (sentCount > 0 ? sentCount : undefined),
    sentPushCount,
    sentInboxCount,
    detail: objectOrSelf(result, {}).detail,
    fail: objectOrSelf(result, {}).fail,
    failures: failures.length > 0 ? failures : undefined,
    contentIds: contentIds.length > 0 ? contentIds : undefined
  };
}

function stubSmartMessageResponse(body: unknown, msgCount: number, now: () => number) {
  const request = objectOrSelf(body, {});
  return {
    ok: true,
    providerRequestId: request.providerRequestId,
    providerStatus: "SENT",
    resultType: "SUCCESS",
    sentAt: request.requestedAt ?? now(),
    msgCount,
    sentPushCount: msgCount,
    sentInboxCount: 0
  };
}

function messageContext(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw clientError("INVALID_MESSAGE_CONTEXT", `${name} must be an object`);
  }
  return value;
}

function resolveTemplateSetCode(body: Record<string, unknown>) {
  return stringOrUndefined(body.templateSetCode ?? body.templateCode);
}

const MESSAGE_RESULT_CHANNELS = ["sentPush", "sentInbox", "sentSms", "sentAlimtalk", "sentFriendtalk"];

function collectMessageFailures(result: unknown) {
  const failures: Array<{ channel: string; contentId?: string; reachFailReason?: string }> = [];
  const fail = objectOrSelf(objectOrSelf(result, {}).fail, {});
  for (const channel of MESSAGE_RESULT_CHANNELS) {
    const entries = Array.isArray(fail[channel]) ? fail[channel] : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      failures.push({
        channel,
        contentId: readPathString(entry, ["contentId", "id"]),
        reachFailReason: readPathString(entry, ["reachFailReason", "reason", "message", "errorMessage"])
      });
    }
  }
  return failures;
}

function collectMessageContentIds(detail: unknown) {
  const contentIds: string[] = [];
  const detailObject = objectOrSelf(detail, {});
  for (const channel of MESSAGE_RESULT_CHANNELS) {
    const entries = Array.isArray(detailObject[channel]) ? detailObject[channel] : [];
    for (const entry of entries) {
      const contentId = readPathString(entry, ["contentId", "id"]);
      if (contentId) contentIds.push(contentId);
    }
  }
  return contentIds;
}

function firstMessageFailureReason(failures: Array<{ reachFailReason?: string }>) {
  for (const failure of failures) {
    if (failure.reachFailReason) return failure.reachFailReason;
  }
  return undefined;
}

function messageStatusOk(status: unknown) {
  const normalized = String(status ?? "").trim().toUpperCase();
  return !["FAILED", "FAIL", "ERROR", "REJECTED"].includes(normalized);
}

