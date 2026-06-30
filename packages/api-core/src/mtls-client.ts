import {
  configError,
  clientError,
  objectOrUndefined,
  parseMaybeJson,
  responseHeadersObject,
  sanitizeHeaders,
  sanitizeResponseHeaders,
  stringOrUndefined
} from "./toss-envelope";
import type {
  MtlsClient,
  NormalizedAppsInTossCoreOptions,
  RawMtlsRequest,
  RawMtlsResponse
} from "./types";

export interface TossMtlsRequest {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  tossUserKey?: string;
}

export interface TossMtlsResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export async function requestToss(
  request: TossMtlsRequest,
  options: NormalizedAppsInTossCoreOptions
): Promise<TossMtlsResponse> {
  const client = await resolveMtlsClient(options);
  const url = resolveMtlsUrl(request.path, options);
  const headers: Record<string, string> = {
    accept: "application/json",
    ...sanitizeHeaders(request.headers)
  };
  const init: RequestInit = {
    method: request.method,
    headers
  };

  if (request.body !== undefined) {
    headers["content-type"] = headers["content-type"] || "application/json";
    init.body = JSON.stringify(request.body);
  }
  if (request.tossUserKey) {
    headers["x-toss-user-key"] = request.tossUserKey;
  }

  const response = await client.request(url, init);
  const raw = await response.text();
  return {
    status: response.status,
    headers: sanitizeResponseHeaders(responseHeadersObject(response.headers)),
    body: parseMaybeJson(raw)
  };
}

export function normalizeRawMtlsRequest(body: unknown): TossMtlsRequest {
  const request = objectOrUndefined(body) || {};
  const method = String(request.method || "POST").trim().toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw clientError("UNSUPPORTED_METHOD", "Unsupported method");
  }
  const path = String(request.path || "").trim();
  if (!isSafeRelativeAbsolutePath(path)) {
    throw clientError("INVALID_PROXY_PATH", "path must be a relative absolute path");
  }
  return {
    method,
    path,
    headers: sanitizeHeaders(objectOrUndefined(request.headers)),
    body: request.body,
    tossUserKey: stringOrUndefined(request.tossUserKey)
  };
}

export async function rawMtlsRequest(
  body: unknown,
  options: NormalizedAppsInTossCoreOptions
): Promise<RawMtlsResponse> {
  const upstream = await requestToss(normalizeRawMtlsRequest(body), options);
  return {
    ok: upstream.status >= 200 && upstream.status < 300,
    status: upstream.status,
    headers: sanitizeResponseHeaders(upstream.headers),
    body: upstream.body
  };
}

export async function resolveMtlsClient(options: NormalizedAppsInTossCoreOptions): Promise<MtlsClient> {
  if (options.mtlsClient) {
    return options.mtlsClient;
  }
  if (!options.mtlsClientFactory) {
    throw configError("MISSING_MTLS_CLIENT", "mTLS client is required in forward mode");
  }
  const appId = stringOrUndefined(options.appId);
  if (!appId) {
    throw configError("MISSING_MTLS_APP_ID", "appId is required when mtlsClientFactory is used");
  }
  return await options.mtlsClientFactory.forApp(appId);
}

export function resolveMtlsUrl(path: string, options: NormalizedAppsInTossCoreOptions) {
  const base = new URL(options.upstreamBaseUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    throw clientError("INVALID_PROXY_PATH", "path must stay within the configured upstream origin");
  }
  return url.toString();
}

function isSafeRelativeAbsolutePath(path: string) {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/^https?:\/\//i.test(path) &&
    !/[\\\u0000-\u001F\u007F]/.test(path)
  );
}

