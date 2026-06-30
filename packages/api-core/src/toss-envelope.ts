import {
  DEFAULT_IAP_ORDER_STATUS_MAX_ATTEMPTS,
  DEFAULT_IAP_ORDER_STATUS_RETRY_DELAY_MS,
  DEFAULT_TOSS_API_BASE_URL,
  type AppsInTossCoreOptions,
  type AppsInTossApiMode,
  type NormalizedAppsInTossCoreOptions
} from "./types";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length"
]);

export class AppsInTossApiError extends Error {
  status: number;
  code: string;
  publicMessage: string;
  override cause?: unknown;

  constructor(status: number, code: string, publicMessage: string, cause: unknown = undefined) {
    super(publicMessage);
    this.name = "AppsInTossApiError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
    this.cause = cause;
  }
}

export const TossMtlsCoreError = AppsInTossApiError;

export function clientError(code: string, publicMessage: string, status = 400, cause: unknown = undefined) {
  return new AppsInTossApiError(status, code, publicMessage, cause);
}

export function configError(code: string, publicMessage: string, cause: unknown = undefined) {
  return new AppsInTossApiError(500, code, publicMessage, cause);
}

export function upstreamError(code: string, publicMessage: string, status = 502, cause: unknown = undefined) {
  return new AppsInTossApiError(status, code, publicMessage, cause);
}

export function publicError(error: unknown) {
  if (error instanceof AppsInTossApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.publicMessage
    };
  }
  return {
    status: 500,
    code: "APPS_IN_TOSS_API_ERROR",
    message: "Apps in Toss API request failed"
  };
}

export function normalizeCoreOptions(options: AppsInTossCoreOptions = {}): NormalizedAppsInTossCoreOptions {
  const mode = normalizeMode(options.mode);
  return {
    ...options,
    mode,
    upstreamBaseUrl: stringOrUndefined(options.upstreamBaseUrl) || DEFAULT_TOSS_API_BASE_URL,
    sleep: options.sleep || defaultSleep,
    now: options.now || Date.now
  };
}

export function normalizeMode(value: unknown): AppsInTossApiMode {
  const mode = String(value || "stub").trim().toLowerCase();
  if (mode !== "stub" && mode !== "forward") {
    throw configError("INVALID_APPS_IN_TOSS_API_MODE", "mode must be stub or forward");
  }
  return mode;
}

export function sanitizeHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) continue;
    if (value === undefined || value === null) continue;
    out[name] = String(value);
  }
  return out;
}

export function sanitizeResponseHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const name = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name) || name === "set-cookie") continue;
    out[name] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return out;
}

export function responseHeadersObject(headers: Headers) {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export function parseMaybeJson(raw: string) {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

export function objectOrSelf(value: unknown, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : fallback;
}

export function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function numberOrUndefined(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function stringOrUndefined(value: unknown) {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

export function positiveIntegerOrUndefined(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function nonNegativeIntegerOrUndefined(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parsePositiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseNonNegativeInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function iapOrderStatusMaxAttempts(options: AppsInTossCoreOptions = {}) {
  return parsePositiveInteger(options.iapOrderStatusMaxAttempts, DEFAULT_IAP_ORDER_STATUS_MAX_ATTEMPTS);
}

export function iapOrderStatusRetryDelayMs(options: AppsInTossCoreOptions = {}) {
  return parseNonNegativeInteger(options.iapOrderStatusRetryDelayMs, DEFAULT_IAP_ORDER_STATUS_RETRY_DELAY_MS);
}

export function normalizeLoginReferrer(value: unknown) {
  const referrer = String(value || "").trim();
  if (referrer.toLowerCase() === "sandbox") {
    return referrer;
  }
  return "DEFAULT";
}

export function normalizeScopes(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((scope) => String(scope).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
  }
  return ["user_key"];
}

export function readPathString(value: unknown, paths: string[]) {
  const found = readPathValue(value, paths);
  if (found === undefined || found === null || found === "") return undefined;
  return String(found);
}

export function readPathValue(value: unknown, paths: string[]) {
  for (const path of paths) {
    let current: unknown = value;
    let found = true;
    for (const segment of path.split(".")) {
      if (current && typeof current === "object" && segment in current) {
        current = (current as Record<string, unknown>)[segment];
      } else {
        found = false;
        break;
      }
    }
    if (found) return current;
  }
  return undefined;
}

export function isUpstreamFailure(value: unknown) {
  const object = objectOrSelf(value, {});
  if (object.ok === false) return true;
  const resultType = String(object.resultType ?? "").trim().toUpperCase();
  return resultType === "FAIL" || resultType === "FAILED" || resultType === "ERROR";
}

export function upstreamFailureReason(value: unknown) {
  return (
    readPathString(value, [
      "failureReason",
      "errorMessage",
      "message",
      "error.reason",
      "error.errorMessage",
      "error.errorCode",
      "error.message",
      "error",
      "success.message",
      "success.reason",
      "data.reason",
      "data.message",
      "raw"
    ]) || "unknown upstream failure"
  );
}

export function upstreamFailureCode(value: unknown) {
  return readPathString(value, [
    "providerErrorCode",
    "errorCode",
    "code",
    "error.errorCode",
    "error.code",
    "success.errorCode",
    "data.errorCode",
    "data.code"
  ]);
}

export function httpStatusOk(status: unknown) {
  return Number.isInteger(status) && Number(status) >= 200 && Number(status) < 300;
}

export function debugLog(
  options: AppsInTossCoreOptions,
  message: string,
  fields: Record<string, unknown> = {}
) {
  if (!options.debug) return;
  if (options.log) {
    options.log(message, fields);
  }
}

export async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return sha256FallbackHex(bytes);
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function sha256FallbackHex(bytes: Uint8Array) {
  const words = new Array(64).fill(0);
  const hash = [
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19
  ];
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength, false);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + constants[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}
