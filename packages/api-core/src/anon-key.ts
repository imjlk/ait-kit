import { requestToss } from "./mtls-client.js";
import {
  httpStatusOk,
  isUpstreamFailure,
  objectOrSelf,
  upstreamFailureCode,
  upstreamFailureReason
} from "./toss-envelope.js";
import {
  TOSS_ENDPOINTS,
  type AnonKeyVerifyInput,
  type AnonKeyVerifyResponse,
  type NormalizedAppsInTossCoreOptions
} from "./types.js";

/**
 * Verifies an anonymous key against the official
 * `POST /api-partner/v1/apps-in-toss/users/anon-key/verify` endpoint. The
 * provider answers with a definitive boolean verdict inside a SUCCESS
 * envelope; FAIL envelopes, non-2xx statuses, and malformed payloads mean no
 * verdict was obtained and surface as `ok: false` (never as `valid: false`).
 * The key is transmitted byte-for-byte in the `x-anon-key` header — the kit
 * never adds or strips caller-side prefixes.
 */
export async function verifyAnonKey(
  body: AnonKeyVerifyInput,
  options: NormalizedAppsInTossCoreOptions
): Promise<AnonKeyVerifyResponse> {
  const request = objectOrSelf(body, {});
  // Strict string check: keys pass through byte-for-byte, so non-string
  // values are rejected instead of being coerced into a different key.
  const anonKey =
    typeof request.anonKey === "string" && request.anonKey.trim() ? request.anonKey : undefined;
  if (!anonKey) {
    return { ok: false, error: "MISSING_ANON_KEY", providerStatus: "ERROR" };
  }
  if (options.mode !== "forward") {
    return { ok: true, valid: true, stub: true };
  }
  let upstream;
  try {
    upstream = await requestToss(
      {
        method: "POST",
        path: TOSS_ENDPOINTS.anonKeyVerify,
        headers: { "x-anon-key": anonKey }
      },
      options
    );
  } catch (error) {
    // Transport rejections (timeout, TLS, network) carry no verdict either
    // way; surface them as a no-verdict failure instead of throwing, so the
    // HTTP fallback and api-client keep the invalid/unavailable distinction.
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      providerStatus: "ERROR",
      error: "UPSTREAM_UNAVAILABLE",
      failureReason: `anonymous key verification request failed: ${message}`
    };
  }
  return normalizeAnonKeyVerifyResponse(upstream.body, upstream.status);
}

export function normalizeAnonKeyVerifyResponse(
  upstream: unknown,
  upstreamStatus = 200
): AnonKeyVerifyResponse {
  if (!httpStatusOk(upstreamStatus) || isUpstreamFailure(upstream)) {
    return {
      ok: false,
      providerStatus: "ERROR",
      failureReason: upstreamFailureReason(upstream),
      providerErrorCode: upstreamFailureCode(upstream),
      upstreamStatus
    };
  }

  const object = objectOrSelf(upstream, {});
  const resultType = String(object.resultType ?? "").trim().toUpperCase();
  if (resultType && resultType !== "SUCCESS") {
    // Envelopes like HTTP_TIMEOUT or NETWORK_ERROR can arrive with a 200
    // status; they carry no verdict either way.
    return {
      ok: false,
      providerStatus: "ERROR",
      failureReason: upstreamFailureReason(upstream),
      providerErrorCode: upstreamFailureCode(upstream),
      upstreamStatus
    };
  }
  if (resultType !== "SUCCESS") {
    // Only a boolean inside an explicit SUCCESS envelope is a verdict.
    return {
      ok: false,
      providerStatus: "ERROR",
      error: "INVALID_RESPONSE",
      failureReason: "verify response was not a SUCCESS envelope",
      upstreamStatus
    };
  }

  if (typeof object.success === "boolean") {
    return { ok: true, valid: object.success };
  }

  return {
    ok: false,
    providerStatus: "ERROR",
    error: "INVALID_RESPONSE",
    failureReason: "verify response did not include a boolean verdict",
    upstreamStatus
  };
}
