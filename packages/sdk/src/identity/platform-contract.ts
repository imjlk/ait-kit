import { SdkError, type SdkAnonymousKey, type SdkLoginResult } from "../index.js";

/**
 * Internal platform contract for the login/anonymous-identity adapters,
 * shared by /rn and /web. Each entry declares its own structural copy of
 * the official SDK surface; this module is the common engine boundary and
 * is never exported from a public subpath.
 */

export interface TossAuthLike {
  login: FunctionWithSupport<() => Promise<unknown>> | undefined;
}

export interface UserLike {
  getAnonymousKey: FunctionWithSupport<() => Promise<unknown>> | undefined;
}

type FunctionWithSupport<F> = F & { isSupported?: () => boolean };


export interface IdentityPlatformSdk {
  TossAuth?: TossAuthLike;
  User?: UserLike;
}

export type IdentityPlatformLoader = () => Promise<
  { available: true; module: IdentityPlatformSdk } | { available: false; reason: string }
>;

const REFERRERS = new Set(["DEFAULT", "SANDBOX"]);

/**
 * Runs the platform login call and validates the result: the
 * authorizationCode must be a non-empty string and the referrer one of the
 * documented values, both preserved verbatim. SDK rejections propagate to
 * the caller unchanged; unsupported environments reject with
 * SdkError("UNSUPPORTED") when the platform exposes isSupported.
 */
export async function runSdkLogin(
  platform: IdentityPlatformSdk
): Promise<SdkLoginResult> {
  const login = platform.TossAuth?.login;
  if (typeof login !== "function") {
    throw new SdkError("UNSUPPORTED", "the installed SDK does not expose TossAuth.login");
  }
  if (typeof login.isSupported === "function" && !login.isSupported()) {
    throw new SdkError("UNSUPPORTED", "login is not supported on this app version");
  }
  // Receiver-preserving member call for class-instance modules.
  const result = await platform.TossAuth!.login!();
  const authorizationCode =
    typeof result === "object" && result !== null
      ? (result as { authorizationCode?: unknown }).authorizationCode
      : undefined;
  const referrer =
    typeof result === "object" && result !== null
      ? (result as { referrer?: unknown }).referrer
      : undefined;
  if (typeof authorizationCode !== "string" || !authorizationCode.trim()) {
    throw new SdkError(
      "INVALID_LOGIN_RESULT",
      "login result did not include a non-blank authorizationCode string"
    );
  }
  if (typeof referrer !== "string" || !REFERRERS.has(referrer)) {
    throw new SdkError(
      "INVALID_LOGIN_RESULT",
      `login result carried an unrecognized referrer: ${String(referrer)}`
    );
  }
  return { authorizationCode, referrer: referrer as SdkLoginResult["referrer"] };
}

/**
 * Runs the anonymous key lookup and validates the documented result shape
 * ({ type: "HASH", hash }): sentinel values, missing or malformed results
 * reject with SdkError("INVALID_ANONYMOUS_KEY") — the adapter never
 * fabricates a key. SDK rejections propagate unchanged.
 */
export async function runSdkGetAnonymousKey(
  platform: IdentityPlatformSdk
): Promise<SdkAnonymousKey> {
  const getAnonymousKey = platform.User?.getAnonymousKey;
  if (typeof getAnonymousKey !== "function") {
    throw new SdkError("UNSUPPORTED", "the installed SDK does not expose User.getAnonymousKey");
  }
  if (
    typeof getAnonymousKey.isSupported === "function" &&
    !getAnonymousKey.isSupported()
  ) {
    throw new SdkError("UNSUPPORTED", "anonymous keys are not supported in this environment");
  }
  const result = await platform.User!.getAnonymousKey!();
  const hash =
    typeof result === "object" && result !== null
      ? (result as { hash?: unknown }).hash
      : undefined;
  const type =
    typeof result === "object" && result !== null
      ? (result as { type?: unknown }).type
      : undefined;
  if (type !== "HASH" || typeof hash !== "string" || !hash) {
    throw new SdkError(
      "INVALID_ANONYMOUS_KEY",
      `anonymous key result was not { type: "HASH", hash }: received ${describe(result)}`
    );
  }
  return { type: "HASH", hash };
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "object") {
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" ? `{ type: ${type} }` : "an unrecognized object";
  }
  return typeof value;
}
