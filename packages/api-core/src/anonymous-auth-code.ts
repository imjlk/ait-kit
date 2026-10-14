import { requestToss } from "./mtls-client.js";
import { normalizeCoreOptions } from "./toss-envelope.js";
import { TOSS_ENDPOINTS, type AppsInTossCoreOptions } from "./types.js";

export interface AnonymousAuthCodeInput { code: string; }
export interface AnonymousAuthCodeOptions extends AppsInTossCoreOptions { signal?: AbortSignal; }
export type AnonymousAuthCodeResult =
  | { ok: true; anonKey: string }
  | { ok: false; error: "ABORTED" | "INVALID_AUTH_CODE" | "FORWARD_MODE_REQUIRED" | "UPSTREAM_UNAVAILABLE" | "EXCHANGE_REJECTED" | "INVALID_RESPONSE"; upstreamStatus?: number };

/**
 * Exchange a single-use SDK 3.6 auth code for an authenticated anonymous key.
 * Unlike verifyAnonKey, this proves possession of a code issued to the current
 * mini-app user. No retries, stub identities, or raw provider errors are emitted.
 */
export async function exchangeAnonAuthCode(
  input: AnonymousAuthCodeInput,
  options: AnonymousAuthCodeOptions
): Promise<AnonymousAuthCodeResult> {
  if (!input || typeof input.code !== "string" || !input.code.trim() || input.code.length > 4096) {
    return { ok: false, error: "INVALID_AUTH_CODE" };
  }
  if (options.mode !== "forward") return { ok: false, error: "FORWARD_MODE_REQUIRED" };
  let response;
  try {
    options.signal?.throwIfAborted();
    response = await requestToss({
      method: "POST",
      path: TOSS_ENDPOINTS.anonAuthCodeExchange,
      body: { code: input.code },
      ...(options.signal ? { signal: options.signal } : {})
    }, normalizeCoreOptions(options));
    options.signal?.throwIfAborted();
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { ok: false, error: "ABORTED" };
    }
    return { ok: false, error: "UPSTREAM_UNAVAILABLE" };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, error: "EXCHANGE_REJECTED", upstreamStatus: response.status };
  }
  const body = response.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "INVALID_RESPONSE" };
  const envelope = body as Record<string, unknown>;
  if (envelope.resultType !== "SUCCESS") return { ok: false, error: "EXCHANGE_REJECTED", upstreamStatus: response.status };
  const success = envelope.success;
  if (!success || typeof success !== "object" || Array.isArray(success)) return { ok: false, error: "INVALID_RESPONSE" };
  const anonKey = (success as Record<string, unknown>).anonKey;
  if (typeof anonKey !== "string" || !anonKey.trim() || anonKey.length > 4096) return { ok: false, error: "INVALID_RESPONSE" };
  return { ok: true, anonKey };
}
