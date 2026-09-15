import { requestToss } from "./mtls-client";
import { normalizeMessageRecipient, recipientIdentifierHeaders, type MessageRecipient } from "./recipient";
import {
  clientError,
  httpStatusOk,
  numberOrUndefined,
  objectOrSelf,
  readPathString,
  readPathValue,
  readStrictNonNegativeIntState,
  readStrictStringState,
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
  // Validate the recipient and template for stub callers too, so bad input is
  // rejected identically regardless of mode (bulk sends already behaved this
  // way by building their upstream body before the stub branch).
  const upstreamBody = messageUpstreamBody(request);
  const headers = messageRecipientHeaders(request);
  if (options.mode !== "forward") {
    return stubSmartMessageResponse(request, 1, options.now);
  }
  const upstream = await requestToss(
    {
      method: "POST",
      path: TOSS_ENDPOINTS.messageSend,
      body: upstreamBody,
      headers
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
      const recipient = normalizeMessageRecipient(
        item,
        "INVALID_CONTEXT_RECIPIENT",
        `contextList[${index}] recipient`
      );
      return {
        ...recipientContextFields(recipient),
        context: messageContext(item.context, `contextList[${index}].context`)
      };
    })
  };
}

/**
 * Envelope resultTypes that are a definite provider rejection of the send.
 */
const MESSAGE_FAILURE_RESULT_TYPES = new Set(["FAIL", "FAILED", "ERROR"]);

/**
 * Envelope resultTypes where the provider could not determine the outcome:
 * the message may or may not have been delivered, so the result stays
 * UNKNOWN instead of asserting a definite failure.
 */
const MESSAGE_OUTCOME_UNKNOWN_RESULT_TYPES = new Set(["NETWORK_ERROR", "TIMEOUT"]);

export function normalizeMessageResponse(
  requestBody: Record<string, unknown>,
  upstream: unknown,
  upstreamStatus = 200,
  now: () => number = Date.now
): SmartMessageResponse {
  const upstreamObject = objectOrSelf(upstream, {});
  const providerRequestId =
    readPathString(upstreamObject, ["providerRequestId", "requestId", "result.providerRequestId"]) ??
    stringOrUndefined(requestBody.providerRequestId);
  // Timestamp provenance: a confirmed send time (with the completion-clock
  // fallback) is only computed on delivery-confirmed branches; failed and
  // unknown outcomes keep provider/request-supplied times only.
  const sentAtWithoutNow = messageSentAtWithoutNow(upstreamObject.sentAt, requestBody.requestedAt);
  const confirmedSentAt = () => sentAtWithoutNow ?? now();

  // Strict envelope classification: the resultType is only trusted as a
  // real string, unknown values are never treated as success, and failure
  // envelopes never lend their result to count-based evidence.
  const envelopeResultType = readStrictStringState(upstream, [
    "resultType",
    "success.resultType",
    "data.resultType"
  ]);
  const resultType = envelopeResultType.state === "present" ? envelopeResultType.value : undefined;

  if (!httpStatusOk(upstreamStatus)) {
    // 4xx: the provider definitely rejected the send. 5xx: the outcome is
    // unknown — the request may or may not have been delivered.
    const unknown = Number(upstreamStatus) >= 500;
    return {
      ok: false,
      providerRequestId,
      providerStatus: unknown ? "UNKNOWN" : "FAILED",
      resultType,
      sentAt: sentAtWithoutNow,
      failureReason: upstreamFailureReason(upstreamObject),
      providerErrorCode: upstreamFailureCode(upstreamObject),
      upstreamStatus
    };
  }

  // An explicit ok:false is a stated failure and always wins over count
  // evidence or a SUCCESS envelope riding along — unless the response is
  // an already-normalized one (it carries this module's providerStatus
  // vocabulary), in which case the normalized branch validates the pair.
  if (upstreamObject.ok === false && upstreamObject.providerStatus === undefined) {
    return {
      ok: false,
      providerRequestId,
      providerStatus: "FAILED",
      resultType,
      sentAt: sentAtWithoutNow,
      failureReason: upstreamFailureReason(upstreamObject),
      providerErrorCode: upstreamFailureCode(upstreamObject)
    };
  }

  if (envelopeResultType.state === "invalid") {
    return unknownMessageResult(
      providerRequestId,
      "resultType was not a string",
      upstreamStatus,
      undefined,
      undefined,
      sentAtWithoutNow
    );
  }
  if (envelopeResultType.state === "present") {
    if (MESSAGE_FAILURE_RESULT_TYPES.has(envelopeResultType.value)) {
      return {
        ok: false,
        providerRequestId,
        providerStatus: "FAILED",
        resultType,
        sentAt: sentAtWithoutNow,
        failureReason: upstreamFailureReason(upstreamObject),
        providerErrorCode: upstreamFailureCode(upstreamObject)
      };
    }
    if (MESSAGE_OUTCOME_UNKNOWN_RESULT_TYPES.has(envelopeResultType.value)) {
      return unknownMessageResult(
        providerRequestId,
        upstreamFailureReason(upstreamObject),
        upstreamStatus,
        resultType,
        upstreamFailureCode(upstreamObject),
        sentAtWithoutNow
      );
    }
    if (envelopeResultType.value !== "SUCCESS") {
      return unknownMessageResult(
        providerRequestId,
        `unrecognized resultType for message send: ${envelopeResultType.value}`,
        upstreamStatus,
        resultType,
        undefined,
        sentAtWithoutNow
      );
    }
  }

  // Already-normalized responses (this module's own providerStatus
  // vocabulary) arrive without an envelope; they are validated under their
  // own explicit rule instead of bypassing the evidence checks: only the
  // statuses this module emits are accepted, and a contradictory ok field
  // invalidates the input.
  if (
    envelopeResultType.state === "absent" &&
    !upstreamObject.result &&
    (upstreamObject.providerStatus !== undefined || upstreamObject.status !== undefined)
  ) {
    const normalizedStatus = readStrictStringState(upstream, ["providerStatus", "status"]);
    if (normalizedStatus.state !== "present") {
      return unknownMessageResult(
        providerRequestId,
        "providerStatus was not a string",
        upstreamStatus,
        undefined,
        undefined,
        sentAtWithoutNow
      );
    }
    const status = normalizedStatus.value.toUpperCase();
    if (status !== "SENT" && status !== "FAILED") {
      return unknownMessageResult(
        providerRequestId,
        `unrecognized normalized providerStatus: ${normalizedStatus.value}`,
        upstreamStatus,
        undefined,
        undefined,
        sentAtWithoutNow
      );
    }
    const okField = upstreamObject.ok;
    if (okField !== undefined && typeof okField !== "boolean") {
      return unknownMessageResult(
        providerRequestId,
        "ok field was not a boolean",
        upstreamStatus,
        undefined,
        undefined,
        sentAtWithoutNow
      );
    }
    if (okField !== undefined && okField !== (status === "SENT")) {
      return unknownMessageResult(
        providerRequestId,
        `contradictory ok field for providerStatus ${normalizedStatus.value}`,
        upstreamStatus,
        undefined,
        undefined,
        sentAtWithoutNow
      );
    }
    if (status !== "SENT") {
      return {
        ok: false,
        providerRequestId,
        providerStatus: normalizedStatus.value,
        sentAt: sentAtWithoutNow,
        failureReason: stringOrUndefined(
          upstreamObject.failureReason ?? upstreamObject.errorMessage ?? upstreamObject.message
        )
      };
    }
    return {
      ok: true,
      providerRequestId,
      providerStatus: normalizedStatus.value,
      sentAt: confirmedSentAt()
    };
  }

  // Official SUCCESS envelope (or a bare official shape): the send result
  // must actually be present. Counts are strict non-negative integers — a
  // wrong-typed count invalidates the evidence, and a result object with
  // neither counts nor failure entries is an unconfirmed outcome.
  const nestedResult = readPathValue(upstreamObject, [
    "result",
    "success.result",
    "success",
    "data.result",
    "data.success"
  ]);
  const result = objectOrSelf(nestedResult, {});
  const countsSource =
    nestedResult !== undefined || !hasTopLevelCountEvidence(upstreamObject) ? result : upstreamObject;

  const countReads = {
    msgCount: readStrictNonNegativeIntState(countsSource, ["msgCount"]),
    sentPushCount: readStrictNonNegativeIntState(countsSource, ["sentPushCount"]),
    sentInboxCount: readStrictNonNegativeIntState(countsSource, ["sentInboxCount"]),
    sentSmsCount: readStrictNonNegativeIntState(countsSource, ["sentSmsCount"]),
    sentAlimtalkCount: readStrictNonNegativeIntState(countsSource, ["sentAlimtalkCount"]),
    sentFriendtalkCount: readStrictNonNegativeIntState(countsSource, ["sentFriendtalkCount"])
  };
  for (const [name, read] of Object.entries(countReads)) {
    if (read.state === "invalid") {
      return unknownMessageResult(
        providerRequestId,
        `${name} was not a non-negative integer`,
        upstreamStatus,
        resultType,
        undefined,
        sentAtWithoutNow
      );
    }
  }
  const msgCount = countReads.msgCount.state === "present" ? countReads.msgCount.value : undefined;
  const sentPushCount =
    countReads.sentPushCount.state === "present" ? countReads.sentPushCount.value : undefined;
  const sentInboxCount =
    countReads.sentInboxCount.state === "present" ? countReads.sentInboxCount.value : undefined;
  const sentSmsCount =
    countReads.sentSmsCount.state === "present" ? countReads.sentSmsCount.value : undefined;
  const sentAlimtalkCount =
    countReads.sentAlimtalkCount.state === "present" ? countReads.sentAlimtalkCount.value : undefined;
  const sentFriendtalkCount =
    countReads.sentFriendtalkCount.state === "present" ? countReads.sentFriendtalkCount.value : undefined;

  const failures = collectMessageFailures(result);
  const contentIds = collectMessageContentIds(result.detail);
  const hasCountEvidence = Object.values(countReads).some((read) => read.state === "present");
  if (!hasCountEvidence && failures.length === 0) {
    // Empty objects, HTML error pages (parsed to { raw }), and SUCCESS
    // envelopes without a send-result object: nothing confirms delivery.
    return unknownMessageResult(
      providerRequestId,
      "response carried no send-result evidence (no counts, no failure entries)",
      upstreamStatus,
      resultType,
      undefined,
      sentAtWithoutNow
    );
  }

  const channelSentCount = [sentPushCount, sentInboxCount, sentSmsCount, sentAlimtalkCount, sentFriendtalkCount]
    .filter((value) => value !== undefined)
    .reduce((a, b) => Number(a) + Number(b), 0);
  const sentCount = Math.max(msgCount ?? 0, channelSentCount);
  const failureReason = firstMessageFailureReason(failures);
  // With evidence guaranteed above, a definite failure requires an actual
  // zero-send outcome with failure entries — an absent failure list alone
  // never decides the outcome.
  const providerStatus = sentCount > 0 || failures.length === 0 ? "SENT" : "FAILED";
  if (providerStatus === "FAILED") {
    return {
      ok: false,
      providerRequestId,
      providerStatus,
      resultType,
      sentAt: sentAtWithoutNow,
      failureReason,
      msgCount: msgCount ?? (sentCount > 0 ? sentCount : undefined),
      sentPushCount,
      sentInboxCount,
      sentSmsCount,
      sentAlimtalkCount,
      sentFriendtalkCount,
      detail: result.detail,
      fail: result.fail,
      failures: failures.length > 0 ? failures : undefined,
      contentIds: contentIds.length > 0 ? contentIds : undefined
    };
  }

  return {
    ok: true,
    providerRequestId,
    providerStatus,
    resultType,
    sentAt: confirmedSentAt(),
    msgCount: msgCount ?? (sentCount > 0 ? sentCount : undefined),
    sentPushCount,
    sentInboxCount,
    sentSmsCount,
    sentAlimtalkCount,
    sentFriendtalkCount,
    detail: result.detail,
    fail: result.fail,
    failures: failures.length > 0 ? failures : undefined,
    contentIds: contentIds.length > 0 ? contentIds : undefined
  };
}

/**
 * A result whose delivery outcome could not be determined. `providerStatus:
 * "UNKNOWN"` (plus the internal `error: "INVALID_RESPONSE"` marker for
 * uninterpretable bodies) tells callers to resolve the state out of band;
 * it never asserts the message was not sent, never fabricates a sentAt,
 * and never triggers an automatic resend.
 */
function unknownMessageResult(
  providerRequestId: string | undefined,
  failureReason: string,
  upstreamStatus?: number,
  resultType?: string,
  providerErrorCode?: string,
  sentAt?: number
): SmartMessageResponse {
  return {
    ok: false,
    providerRequestId,
    providerStatus: "UNKNOWN",
    error: "INVALID_RESPONSE",
    resultType,
    failureReason,
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
    ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
    // Supplied (provider/request) timestamps survive as correlation data;
    // only the clock fallback is withheld for unconfirmed outcomes.
    ...(sentAt !== undefined ? { sentAt } : {})
  };
}

function hasTopLevelCountEvidence(value: Record<string, unknown>) {
  return ["msgCount", "sentPushCount", "sentInboxCount", "sentSmsCount", "sentAlimtalkCount", "sentFriendtalkCount"].some(
    (key) => value[key] !== undefined
  );
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

/**
 * Per-API recipient conversion for single (and test) message sends: the
 * official API carries the recipient in the `x-toss-user-key` or `x-anon-key`
 * request header — never in the body. Values pass through byte-for-byte.
 */
function messageRecipientHeaders(body: Record<string, unknown>): Record<string, string> {
  const recipient = normalizeMessageRecipient(body, "INVALID_MESSAGE_RECIPIENT", "message recipient");
  return recipientIdentifierHeaders(recipient);
}

/**
 * Per-API recipient conversion for bulk sends: recipients ride in each
 * `contextList` item's body fields (`userKey` or `anonKey`), not in headers.
 */
function recipientContextFields(recipient: MessageRecipient): Record<string, string | number> {
  return recipient.kind === "user" ? { userKey: recipient.userKey } : { anonKey: recipient.anonKey };
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

/**
 * Timestamp provenance for outcomes that were not confirmed as sent: only
 * provider-supplied or caller-requested times are kept — the current clock
 * is never used to fabricate a send time for a failed or unknown result.
 */
function messageSentAtWithoutNow(upstreamSentAt: unknown, requestSentAt: unknown) {
  const upstreamTimestamp = upstreamSentAt === undefined || upstreamSentAt === null ? undefined : numberOrUndefined(upstreamSentAt);
  const requestTimestamp = requestSentAt === undefined || requestSentAt === null ? undefined : numberOrUndefined(requestSentAt);
  return upstreamTimestamp ?? requestTimestamp;
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
