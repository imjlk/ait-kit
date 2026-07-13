import { requestToss } from "./mtls-client";
import {
  clientError,
  httpStatusOk,
  isUpstreamFailure,
  nonNegativeIntegerOrUndefined,
  numberOrUndefined,
  objectOrSelf,
  readPathString,
  readPathValue,
  stringOrUndefined,
  upstreamFailureCode,
  upstreamFailureReason
} from "./toss-envelope";
import {
  SMART_MESSAGE_BULK_MAX_CONTEXTS,
  TOSS_ENDPOINTS,
  type NormalizedAppsInTossCoreOptions,
  type SmartMessageBulkSendInput,
  type SmartMessageResponse,
  type SmartMessageSendInput
} from "./types";

export async function sendSmartMessage(
  body: SmartMessageSendInput,
  options: NormalizedAppsInTossCoreOptions
): Promise<SmartMessageResponse> {
  const request = objectOrSelf(body, {});
  if (options.mode !== "forward") {
    return stubSmartMessageResponse(request, 1, options.now);
  }
  const upstream = await requestToss(
    {
      method: "POST",
      path: TOSS_ENDPOINTS.messageSend,
      body: messageUpstreamBody(request),
      headers: messageRecipientHeaders(request)
    },
    options
  );
  return normalizeMessageResponse(request, upstream.body, upstream.status, options.now);
}

export async function bulkSendSmartMessage(
  body: SmartMessageBulkSendInput,
  options: NormalizedAppsInTossCoreOptions
): Promise<SmartMessageResponse> {
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
      const recipient = messageRecipient(
        item,
        "INVALID_CONTEXT_RECIPIENT",
        `contextList[${index}] must include exactly one of userKey, tossUserKey, or anonKey`
      );
      return {
        ...recipient,
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
): SmartMessageResponse {
  const upstreamObject = objectOrSelf(upstream, {});
  const resultType = readPathString(upstreamObject, ["resultType", "success.resultType", "data.resultType"]);
  const providerRequestId =
    readPathString(upstreamObject, ["providerRequestId", "requestId", "result.providerRequestId"]) ??
    stringOrUndefined(requestBody.providerRequestId);
  const sentAt = messageSentAt(upstreamObject.sentAt, requestBody.requestedAt, now);

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
    const providerStatusText = String(providerStatus);
    const ok = typeof upstreamObject.ok === "boolean" ? upstreamObject.ok : messageStatusOk(providerStatus);
    if (!ok) {
      return {
        ok: false,
        providerRequestId,
        providerStatus: providerStatusText,
        sentAt,
        failureReason: stringOrUndefined(upstreamObject.failureReason ?? upstreamObject.errorMessage ?? upstreamObject.message)
      };
    }
    return {
      ok: true,
      providerRequestId,
      providerStatus: providerStatusText,
      sentAt
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
  const sentSmsCount = nonNegativeIntegerOrUndefined(readPathValue(result, ["sentSmsCount"]));
  const sentAlimtalkCount = nonNegativeIntegerOrUndefined(readPathValue(result, ["sentAlimtalkCount"]));
  const sentFriendtalkCount = nonNegativeIntegerOrUndefined(readPathValue(result, ["sentFriendtalkCount"]));
  const failures = collectMessageFailures(result);
  const contentIds = collectMessageContentIds(objectOrSelf(result, {}).detail);
  const channelSentCount = [sentPushCount, sentInboxCount, sentSmsCount, sentAlimtalkCount, sentFriendtalkCount]
    .filter((value) => value !== undefined)
    .reduce((a, b) => Number(a) + Number(b), 0);
  const sentCount = Math.max(msgCount ?? 0, channelSentCount);
  const failureReason = firstMessageFailureReason(failures);
  const providerStatus = sentCount > 0 || failures.length === 0 ? "SENT" : "FAILED";
  if (providerStatus === "FAILED") {
    return {
      ok: false,
      providerRequestId,
      providerStatus,
      resultType,
      sentAt,
      failureReason,
      msgCount: msgCount ?? (sentCount > 0 ? sentCount : undefined),
      sentPushCount,
      sentInboxCount,
      sentSmsCount,
      sentAlimtalkCount,
      sentFriendtalkCount,
      detail: objectOrSelf(result, {}).detail,
      fail: objectOrSelf(result, {}).fail,
      failures: failures.length > 0 ? failures : undefined,
      contentIds: contentIds.length > 0 ? contentIds : undefined
    };
  }

  return {
    ok: true,
    providerRequestId,
    providerStatus,
    resultType,
    sentAt,
    msgCount: msgCount ?? (sentCount > 0 ? sentCount : undefined),
    sentPushCount,
    sentInboxCount,
    sentSmsCount,
    sentAlimtalkCount,
    sentFriendtalkCount,
    detail: objectOrSelf(result, {}).detail,
    fail: objectOrSelf(result, {}).fail,
    failures: failures.length > 0 ? failures : undefined,
    contentIds: contentIds.length > 0 ? contentIds : undefined
  };
}

function stubSmartMessageResponse(body: unknown, msgCount: number, now: () => number): SmartMessageResponse {
  const request = objectOrSelf(body, {});
  return {
    ok: true,
    providerRequestId: stringOrUndefined(request.providerRequestId),
    providerStatus: "SENT",
    resultType: "SUCCESS",
    sentAt: messageSentAt(undefined, request.requestedAt, now),
    msgCount,
    sentPushCount: msgCount,
    sentInboxCount: 0,
    sentSmsCount: 0,
    sentAlimtalkCount: 0,
    sentFriendtalkCount: 0
  };
}

function messageRecipientHeaders(body: Record<string, unknown>): Record<string, string> {
  const recipient = messageRecipient(
    body,
    "INVALID_MESSAGE_RECIPIENT",
    "exactly one of userKey, tossUserKey, or anonKey is required"
  );
  return "userKey" in recipient
    ? { "x-user-key": String(recipient.userKey) }
    : { "x-anon-key": recipient.anonKey };
}

function messageRecipient(
  body: Record<string, unknown>,
  errorCode: string,
  errorMessage: string
): { userKey: string | number } | { anonKey: string } {
  const userKey = messageRecipientValue(body.userKey);
  const tossUserKey = messageRecipientValue(body.tossUserKey);
  const anonKey = typeof body.anonKey === "string" ? stringOrUndefined(body.anonKey) : undefined;
  if (userKey !== undefined && tossUserKey === undefined && anonKey === undefined) return { userKey };
  if (tossUserKey !== undefined && userKey === undefined && anonKey === undefined) {
    return { userKey: tossUserKey };
  }
  if (anonKey !== undefined && userKey === undefined && tossUserKey === undefined) return { anonKey };
  throw clientError(errorCode, errorMessage);
}

function messageRecipientValue(value: unknown): string | number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  return typeof value === "string" ? stringOrUndefined(value) : undefined;
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

function messageSentAt(upstreamSentAt: unknown, requestSentAt: unknown, now: () => number) {
  const upstreamTimestamp = upstreamSentAt === undefined || upstreamSentAt === null ? undefined : numberOrUndefined(upstreamSentAt);
  const requestTimestamp = requestSentAt === undefined || requestSentAt === null ? undefined : numberOrUndefined(requestSentAt);
  return upstreamTimestamp ?? requestTimestamp ?? now();
}

const MESSAGE_RESULT_CHANNELS = ["sentPush", "sentInbox", "sentSms", "sentAlimtalk", "sentFriendtalk"];

function collectMessageFailures(result: unknown) {
  const failures: Array<{ channel: string; contentId?: string; reachedFailReason?: string }> = [];
  const fail = objectOrSelf(objectOrSelf(result, {}).fail, {});
  for (const channel of MESSAGE_RESULT_CHANNELS) {
    const entries = Array.isArray(fail[channel]) ? fail[channel] : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      failures.push({
        channel,
        contentId: readPathString(entry, ["contentId", "id"]),
        reachedFailReason: readPathString(entry, [
          "reachedFailReason",
          "reachFailReason",
          "reason",
          "message",
          "errorMessage"
        ])
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

function firstMessageFailureReason(failures: Array<{ reachedFailReason?: string }>) {
  for (const failure of failures) {
    if (failure.reachedFailReason) return failure.reachedFailReason;
  }
  return undefined;
}

function messageStatusOk(status: unknown) {
  const normalized = String(status ?? "").trim().toUpperCase();
  return !["FAILED", "FAIL", "ERROR", "REJECTED"].includes(normalized);
}
