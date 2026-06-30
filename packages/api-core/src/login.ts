import { requestToss } from "./mtls-client";
import {
  debugLog,
  isUpstreamFailure,
  normalizeLoginReferrer,
  normalizeScopes,
  objectOrSelf,
  readPathString,
  readPathValue,
  sha256Hex,
  stringOrUndefined,
  upstreamFailureReason,
  upstreamFailureCode,
  httpStatusOk
} from "./toss-envelope";
import { TOSS_ENDPOINTS, type NormalizedAppsInTossCoreOptions } from "./types";

export async function completeTossLogin(body: unknown, options: NormalizedAppsInTossCoreOptions) {
  if (options.mode !== "forward") {
    return stubLoginResponse(body);
  }

  const request = objectOrSelf(body, {});
  const authorizationCode = String(request.authorizationCode || request.authorization_code || "").trim();
  if (!authorizationCode) {
    return { ok: false, error: "MISSING_AUTHORIZATION_CODE" };
  }

  const referrer = normalizeLoginReferrer(request.referrer);
  const tokenResponse = await requestToss(
    {
      method: "POST",
      path: TOSS_ENDPOINTS.loginGenerateToken,
      body: { authorizationCode, referrer }
    },
    options
  );
  if (isUpstreamFailure(tokenResponse.body)) {
    debugLog(options, "toss login token exchange failed", {
      status: tokenResponse.status,
      errorCode: readPathString(tokenResponse.body, ["error.errorCode", "errorCode"]),
      failureReason: upstreamFailureReason(tokenResponse.body)
    });
    return {
      ok: false,
      error: "TOKEN_EXCHANGE_FAILED",
      failureReason: upstreamFailureReason(tokenResponse.body)
    };
  }

  const accessToken = readPathString(tokenResponse.body, [
    "success.accessToken",
    "accessToken",
    "data.accessToken",
    "access_token",
    "success.access_token",
    "data.access_token"
  ]);
  if (!accessToken) {
    return { ok: false, error: "TOKEN_RESPONSE_MISSING_ACCESS_TOKEN" };
  }

  const userResponse = await requestToss(
    {
      method: "GET",
      path: TOSS_ENDPOINTS.loginMe,
      headers: { authorization: bearerAuthorization(accessToken) }
    },
    options
  );
  if (isUpstreamFailure(userResponse.body)) {
    debugLog(options, "toss login user lookup failed", {
      status: userResponse.status,
      errorCode: readPathString(userResponse.body, ["error.errorCode", "errorCode"]),
      failureReason: upstreamFailureReason(userResponse.body)
    });
    return {
      ok: false,
      error: "LOGIN_ME_FAILED",
      failureReason: upstreamFailureReason(userResponse.body)
    };
  }

  const userKey = readPathString(userResponse.body, [
    "success.userKey",
    "userKey",
    "data.userKey",
    "user_key",
    "success.user_key",
    "data.user_key"
  ]);
  if (!userKey) {
    return { ok: false, error: "LOGIN_ME_MISSING_USER_KEY" };
  }

  return {
    ok: true,
    userKey,
    referrer,
    scopes: normalizeScopes(
      readPathValue(userResponse.body, [
        "success.scope",
        "scope",
        "data.scope",
        "success.scopes",
        "scopes",
        "data.scopes"
      ]) ??
        readPathValue(tokenResponse.body, [
          "success.scope",
          "scope",
          "data.scope",
          "success.scopes",
          "scopes",
          "data.scopes"
        ])
    ),
    agreedTerms: readPathValue(userResponse.body, ["success.agreedTerms", "agreedTerms", "data.agreedTerms"]) ?? [],
    accessToken,
    refreshToken: readPathString(tokenResponse.body, [
      "success.refreshToken",
      "refreshToken",
      "data.refreshToken",
      "success.refresh_token",
      "refresh_token",
      "data.refresh_token"
    ]),
    tokenType: readPathString(tokenResponse.body, [
      "success.tokenType",
      "tokenType",
      "data.tokenType",
      "success.token_type",
      "token_type",
      "data.token_type"
    ]),
    expiresIn: readPathValue(tokenResponse.body, [
      "success.expiresIn",
      "expiresIn",
      "data.expiresIn",
      "success.expires_in",
      "expires_in",
      "data.expires_in"
    ])
  };
}

export async function removeTossLoginByUserKey(body: unknown, options: NormalizedAppsInTossCoreOptions) {
  if (options.mode !== "forward") {
    return stubLoginRemoveByUserKey(body);
  }

  const request = objectOrSelf(body, {});
  const tossUserKey = unlinkTossUserKey(request);
  if (!tossUserKey) {
    return { ok: false, error: "MISSING_TOSS_USER_KEY", providerStatus: "ERROR" };
  }
  const accessToken = tossLoginAccessToken(request);
  if (!accessToken) {
    return { ok: false, error: "MISSING_TOSS_ACCESS_TOKEN", providerStatus: "ERROR" };
  }

  const upstream = await requestToss(
    {
      method: "POST",
      path: TOSS_ENDPOINTS.loginRemoveByUserKey,
      headers: { authorization: bearerAuthorization(accessToken) },
      body: { userKey: tossUserKey },
      tossUserKey
    },
    options
  );
  return normalizeTossLoginRemoveByUserKeyResponse(upstream.body, upstream.status, [tossUserKey, accessToken]);
}

export async function stubLoginResponse(body: unknown) {
  const request = objectOrSelf(body, {});
  const seed = `${request.authorizationCode || ""}:${request.referrer || ""}`;
  const digest = await sha256Hex(seed);
  return {
    ok: true,
    userKey: `stub-login:${digest.slice(0, 24)}`,
    referrer: normalizeLoginReferrer(request.referrer),
    scopes: ["user_key"],
    agreedTerms: []
  };
}

export function normalizeTossLoginRemoveByUserKeyResponse(
  upstream: unknown,
  upstreamStatus = 200,
  sensitiveValues: unknown[] = []
) {
  const resultType = readPathString(upstream, ["resultType", "success.resultType", "data.resultType"]);
  if (!httpStatusOk(upstreamStatus) || isUpstreamFailure(upstream) || hasTopLevelUpstreamError(upstream)) {
    return {
      ok: false,
      providerStatus: "FAILED",
      resultType,
      failureReason: redactSensitiveValues(upstreamFailureReason(upstream), sensitiveValues),
      providerErrorCode: upstreamFailureCode(upstream),
      upstreamStatus
    };
  }
  return {
    ok: true,
    providerStatus: "REMOVED",
    resultType: resultType ?? "SUCCESS"
  };
}

function stubLoginRemoveByUserKey(body: unknown) {
  if (!unlinkTossUserKey(objectOrSelf(body, {}))) {
    return { ok: false, error: "MISSING_TOSS_USER_KEY", providerStatus: "ERROR" };
  }
  return {
    ok: true,
    providerStatus: "REMOVED",
    resultType: "SUCCESS"
  };
}

function unlinkTossUserKey(value: Record<string, unknown>) {
  return stringOrUndefined(value.tossUserKey ?? value.userKey ?? value.user_key);
}

function tossLoginAccessToken(value: Record<string, unknown>) {
  return bearerTokenValue(value.accessToken ?? value.tossAccessToken ?? value.tossLoginAccessToken ?? value.access_token);
}

function bearerAuthorization(accessToken: unknown) {
  const token = bearerTokenValue(accessToken);
  return token ? `Bearer ${token}` : "";
}

function bearerTokenValue(value: unknown) {
  const token = stringOrUndefined(value);
  if (!token) return "";
  const match = token.match(/^Bearer\s+(.+)$/i);
  return stringOrUndefined(match ? match[1] : token) || "";
}

function hasTopLevelUpstreamError(value: unknown) {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "error")) {
    return false;
  }
  const error = (value as Record<string, unknown>).error;
  if (error === undefined || error === null || error === "") {
    return false;
  }
  return typeof error !== "object" || Object.keys(error).length > 0;
}

function redactSensitiveValue(value: unknown, sensitive: unknown) {
  if (value === undefined || value === null) {
    return value;
  }
  const secret = String(sensitive || "");
  if (!secret) {
    return String(value);
  }
  return String(value).split(secret).join("[redacted]");
}

function redactSensitiveValues(value: unknown, sensitiveValues: unknown[]) {
  const values = Array.isArray(sensitiveValues) ? sensitiveValues : [sensitiveValues];
  return values.reduce((current, sensitive) => redactSensitiveValue(current, sensitive), value);
}

