export type {
  AppsInTossApiRpc,
  MtlsClient,
  MtlsClientFactory,
  TossMtlsCore,
  TossMtlsCoreOptions
} from "@ait-kit/api-core";

export const PROXY_ENDPOINTS = Object.freeze({
  health: "/internal/apps-in-toss/health",
  genericMtlRequest: "/internal/mtls/request",
  genericMtlsRequest: "/internal/mtls/request",
  tossLoginComplete: "/internal/apps-in-toss/toss-login/complete",
  tossLoginRemoveByUserKey: "/internal/apps-in-toss/toss-login/remove-by-user-key",
  iapOrderStatus: "/internal/apps-in-toss/iap/order/status",
  promotionRewardGrant: "/internal/apps-in-toss/promotion/reward/grant",
  smartMessageSend: "/internal/apps-in-toss/smart-message/send",
  smartMessageBulkSend: "/internal/apps-in-toss/smart-message/send-bulk"
});

export interface TossMtlsHttpClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: FetchLike;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TossMtlsHttpClient {
  health(): Promise<unknown>;
  genericMtlsRequest(body: unknown): Promise<unknown>;
  tossLoginComplete(body: unknown): Promise<unknown>;
  tossLoginRemoveByUserKey(body: unknown): Promise<unknown>;
  iapOrderStatus(body: unknown): Promise<unknown>;
  promotionRewardGrant(body: unknown): Promise<unknown>;
  smartMessageSend(body: unknown): Promise<unknown>;
  smartMessageBulkSend(body: unknown): Promise<unknown>;
}

export class TossMtlsHttpClientError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    super(`Toss mTLS proxy request failed with HTTP ${status}`);
    this.name = "TossMtlsHttpClientError";
    this.status = status;
    this.body = body;
  }
}

export function createTossMtlsHttpClient(options: TossMtlsHttpClientOptions): TossMtlsHttpClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch || globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("fetch is required to create a Toss mTLS HTTP client");
  }

  const request = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = {
      accept: "application/json"
    };
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`;
    }
    const init: RequestInit = {
      method,
      headers
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(`${baseUrl}${path}`, init);
    const text = await response.text();
    const parsed = parseMaybeJson(text);
    if (!response.ok) {
      throw new TossMtlsHttpClientError(response.status, parsed);
    }
    return parsed;
  };

  return {
    health: () => request("GET", PROXY_ENDPOINTS.health),
    genericMtlsRequest: (body: unknown) => request("POST", PROXY_ENDPOINTS.genericMtlsRequest, body),
    tossLoginComplete: (body: unknown) => request("POST", PROXY_ENDPOINTS.tossLoginComplete, body),
    tossLoginRemoveByUserKey: (body: unknown) => request("POST", PROXY_ENDPOINTS.tossLoginRemoveByUserKey, body),
    iapOrderStatus: (body: unknown) => request("POST", PROXY_ENDPOINTS.iapOrderStatus, body),
    promotionRewardGrant: (body: unknown) => request("POST", PROXY_ENDPOINTS.promotionRewardGrant, body),
    smartMessageSend: (body: unknown) => request("POST", PROXY_ENDPOINTS.smartMessageSend, body),
    smartMessageBulkSend: (body: unknown) => request("POST", PROXY_ENDPOINTS.smartMessageBulkSend, body)
  };
}

function normalizeBaseUrl(baseUrl: string) {
  const value = String(baseUrl || "").trim();
  if (!value) {
    throw new Error("baseUrl is required");
  }
  return value.replace(/\/+$/, "");
}

function parseMaybeJson(raw: string) {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}
