import {
  SdkError,
  type SdkAnonymousAuthCode,
  type SdkAnonymousKey,
  type SdkAnonymousKeyLookupOptions,
  type SdkLoginResult
} from "../index.js";

/**
 * Internal platform contract for the login/anonymous-identity adapters,
 * shared by /rn and /webview. Each entry declares its own structural copy of
 * the official SDK surface; this module is the common engine boundary and
 * is never exported from a public subpath.
 */

export interface TossAuthLike {
  login: FunctionWithSupport<() => Promise<unknown>> | undefined;
}

export interface UserLike {
  createAnonymousKeyAuthCode?: FunctionWithSupport<() => Promise<unknown>>;
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
  if (type !== "HASH" || typeof hash !== "string" || !hash.trim()) {
    throw new SdkError(
      "INVALID_ANONYMOUS_KEY",
      `anonymous key result was not { type: "HASH", hash } with a non-blank hash: received ${describe(result)}`
    );
  }
  return { type: "HASH", hash };
}

const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Builds one adapter's anonymous key lookup. While a lookup (loader + SDK
 * call) is pending, every new caller joins it instead of starting another —
 * including callers arriving after an earlier caller's deadline elapsed — so
 * a host that never answers holds at most one bridge call (and listener) per
 * adapter. The shared call is dropped as soon as it settles, so the next
 * lookup asks the SDK again; results are never cached.
 *
 * `timeoutMs` bounds only the waiting caller: it rejects with
 * SdkError("TIMEOUT") and never cancels the shared call (the official
 * bridges expose no cancellation).
 */
export function createSharedAnonymousKeyLookup(
  load: () => Promise<IdentityPlatformSdk>
): (options?: SdkAnonymousKeyLookupOptions) => Promise<SdkAnonymousKey> {
  let inFlight: Promise<SdkAnonymousKey> | undefined;
  const join = (): Promise<SdkAnonymousKey> => {
    if (inFlight) return inFlight;
    const call = (async () => runSdkGetAnonymousKey(await load()))();
    inFlight = call;
    // Registered before any caller's handler, so a caller continuing after
    // settlement already starts a fresh lookup. Also marks the shared
    // rejection handled when every caller has timed out.
    const clear = () => {
      if (inFlight === call) inFlight = undefined;
    };
    call.then(clear, clear);
    return call;
  };
  return async (options) => {
    const timeoutMs = options?.timeoutMs ?? 0;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new SdkError("INVALID_IDENTITY_INPUT", `timeoutMs must be an integer from 0 to ${MAX_TIMEOUT_MS}`);
    }
    const shared = join();
    if (timeoutMs === 0) return shared;
    return new Promise<SdkAnonymousKey>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SdkError(
          "TIMEOUT",
          `anonymous key lookup did not settle within ${timeoutMs}ms; the SDK call is still pending and later lookups will join it`
        ));
      }, timeoutMs);
      shared.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  };
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

/** SDK 3.6+ server-authentication code flow; never falls back to a client hash. */
export async function runSdkCreateAnonymousKeyAuthCode(platform: IdentityPlatformSdk): Promise<SdkAnonymousAuthCode> {
  const createCode = platform.User?.createAnonymousKeyAuthCode;
  if (typeof createCode !== "function" || (typeof createCode.isSupported === "function" && !createCode.isSupported())) {
    throw new SdkError("UNSUPPORTED", "anonymous authentication codes require a supported SDK 3.6+ runtime");
  }
  const result = await platform.User!.createAnonymousKeyAuthCode!();
  const value = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
  if (typeof value.code !== "string" || !value.code.trim() || value.code.length > 4096
    || typeof value.expiresIn !== "number" || !Number.isSafeInteger(value.expiresIn) || value.expiresIn <= 0) {
    throw new SdkError("INVALID_ANONYMOUS_AUTH_CODE", "SDK returned an invalid anonymous authentication code response");
  }
  return { code: value.code, expiresIn: value.expiresIn };
}
