export const DEFAULT_TOSS_API_BASE_URL = "https://apps-in-toss-api.toss.im";

export const SMART_MESSAGE_BULK_MAX_CONTEXTS = 2_500;
export const DEFAULT_IAP_ORDER_STATUS_MAX_ATTEMPTS = 6;
export const DEFAULT_IAP_ORDER_STATUS_RETRY_DELAY_MS = 350;

export const TOSS_ENDPOINTS = Object.freeze({
  loginGenerateToken: "/api-partner/v1/apps-in-toss/user/oauth2/generate-token",
  loginMe: "/api-partner/v1/apps-in-toss/user/oauth2/login-me",
  loginRemoveByUserKey: "/api-partner/v1/apps-in-toss/user/oauth2/access/remove-by-user-key",
  promotionGetKey: "/api-partner/v1/apps-in-toss/promotion/execute-promotion/get-key",
  promotionExecute: "/api-partner/v1/apps-in-toss/promotion/execute-promotion",
  promotionResult: "/api-partner/v1/apps-in-toss/promotion/execution-result",
  iapOrderStatus: "/api-partner/v1/apps-in-toss/order/get-order-status",
  messageSend: "/api-partner/v1/apps-in-toss/messenger/send-message",
  messageBulkSend: "/api-partner/v1/apps-in-toss/messenger/send-bulk-message"
});

export type AppsInTossApiMode = "stub" | "forward";
export type JsonObject = Record<string, unknown>;

export interface MtlsClient {
  request(url: string, init: RequestInit): Promise<Response>;
}

export interface MtlsClientFactory {
  forApp(appId: string): Promise<MtlsClient>;
}

export interface AppsInTossCoreOptions {
  mode?: AppsInTossApiMode | string;
  upstreamBaseUrl?: string;
  mtlsClient?: MtlsClient;
  mtlsClientFactory?: MtlsClientFactory;
  appId?: string;
  tossPromotionCode?: string;
  tossPromotionAmount?: number;
  iapOrderStatusMaxAttempts?: number;
  iapOrderStatusRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  debug?: boolean;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface NormalizedAppsInTossCoreOptions extends AppsInTossCoreOptions {
  mode: AppsInTossApiMode;
  upstreamBaseUrl: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface HealthResponse {
  ok: true;
  mode: AppsInTossApiMode;
  scope: "apps-in-toss-api";
}

export interface RawMtlsRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  tossUserKey?: string;
}

export interface RawMtlsResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface AppsInTossApi {
  health(): Promise<HealthResponse>;
  raw: {
    request(body: unknown): Promise<RawMtlsResponse>;
  };
  login: {
    complete(body: unknown): Promise<unknown>;
    removeByUserKey(body: unknown): Promise<unknown>;
  };
  iap: {
    orderStatus(body: unknown): Promise<unknown>;
  };
  promotion: {
    rewardGrant(body: unknown): Promise<unknown>;
  };
  smartMessage: {
    send(body: unknown): Promise<unknown>;
    bulkSend(body: unknown): Promise<unknown>;
  };
}

export interface AppsInTossApiRpc {
  health(): Promise<HealthResponse>;
  rawMtlsRequest(body: unknown): Promise<RawMtlsResponse>;
  genericMtlsRequest(body: unknown): Promise<RawMtlsResponse>;
  tossLoginComplete(body: unknown): Promise<unknown>;
  tossLoginRemoveByUserKey(body: unknown): Promise<unknown>;
  iapOrderStatus(body: unknown): Promise<unknown>;
  promotionRewardGrant(body: unknown): Promise<unknown>;
  smartMessageSend(body: unknown): Promise<unknown>;
  smartMessageBulkSend(body: unknown): Promise<unknown>;
}

export type TossMtlsMode = AppsInTossApiMode;
export type TossMtlsCoreOptions = AppsInTossCoreOptions;
export type TossMtlsCore = AppsInTossApiRpc;
