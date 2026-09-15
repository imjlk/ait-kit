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
  allowRawMtls?: boolean;
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
  allowRawMtls: boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface HealthChecks {
  mtlsClient: boolean;
  rawMtlsEnabled: boolean;
}

export type HealthResponse =
  | {
      ok: true;
      ready: true;
      mode: AppsInTossApiMode;
      scope: "apps-in-toss-api";
      checks: HealthChecks;
    }
  | {
      ok: false;
      ready: false;
      mode: AppsInTossApiMode;
      scope: "apps-in-toss-api";
      error: string;
      checks: HealthChecks;
    };

export interface ProviderFailure {
  ok: false;
  error?: string;
  orderId?: string;
  providerStatus?: string;
  resultType?: string;
  failureReason?: string;
  providerErrorCode?: string;
  upstreamStatus?: number;
}

export interface TossLoginCompleteInput {
  authorizationCode?: string;
  authorization_code?: string;
  referrer?: string;
}

export type TossLoginCompleteResponse =
  | {
      ok: true;
      userKey: string;
      referrer: string;
      scopes: string[];
      agreedTerms: unknown[];
      accessToken?: string;
      refreshToken?: string;
      tokenType?: string;
      expiresIn?: number;
    }
  | ProviderFailure;

export interface TossLoginRemoveByUserKeyInput {
  tossUserKey?: string;
  userKey?: string;
  user_key?: string;
  accessToken?: string;
  tossAccessToken?: string;
  tossLoginAccessToken?: string;
  access_token?: string;
}

export type TossLoginRemoveByUserKeyResponse =
  | {
      ok: true;
      providerStatus: "REMOVED";
      resultType?: string;
    }
  | ProviderFailure;

/**
 * Input for the Apps in Toss in-app-purchase order status query.
 *
 * The official `get-order-status` request body only accepts `orderId`;
 * `sku` is a caller-side expectation and is never sent upstream or used as
 * verification evidence.
 */
export interface IapOrderStatusInput {
  orderId?: string;
  tossUserKey?: string;
  /**
   * Expected product SKU, compared only against the provider-returned SKU
   * (see `IapOrderStatusResponse.skuCheck`). Never substitutes for missing
   * provider evidence and never creates a payable state on its own.
   */
  sku?: string;
}

/**
 * Why a successfully queried order did not verify as a payable purchase.
 * Ordered with the provider status that produces each code.
 */
export type IapVerificationCode =
  | "PAYMENT_INCOMPLETE" // ORDER_IN_PROGRESS (and legacy pending states; retryable)
  | "PAYMENT_FAILED" // FAILED
  | "PAYMENT_REFUNDED" // REFUNDED
  | "MINIAPP_MISMATCH" // MINIAPP_MISMATCH
  | "ORDER_NOT_FOUND" // NOT_FOUND (retryable per the pending re-query flow)
  | "ORDER_ID_MISMATCH" // provider-returned orderId differs from the request
  | "UNKNOWN_STATUS" // status outside the documented provider enum
  | "PROVIDER_STATUS_ERROR" // ERROR
  | "STUB_EVIDENCE"; // synthetic stub output; never provider evidence

/** Outcome of comparing the caller's expected SKU with provider evidence. */
export type IapSkuCheckStatus = "MATCHED" | "MISMATCHED" | "NOT_PROVIDED";

/** Shared evidence fields for both verified and unverified query successes. */
interface IapOrderStatusSuccess {
  /** The provider status query succeeded with a valid payload. */
  ok: true;
  /**
   * Order ID exactly as returned by the provider. Never copied from the
   * request; a payload without it fails with `error: "INVALID_RESPONSE"`.
   */
  orderId: string;
  /**
   * Product SKU exactly as returned by the provider. Never backfilled
   * from the request expectation.
   */
  sku?: string;
  providerStatus: string;
  statusDeterminedAt?: string;
  reason?: string;
  attempts?: number;
  /**
   * Present exactly when the caller supplied an expected SKU.
   * `providerSku` mirrors `sku` for convenience.
   */
  skuCheck?: {
    status: IapSkuCheckStatus;
    providerSku?: string;
  };
  /** Synthetic stub-mode output; never present in forward mode. */
  stub?: true;
}

/** Provider evidence confirms a payable purchase for the requested order. */
export interface IapOrderVerifiedResponse extends IapOrderStatusSuccess {
  verified: true;
}

/** The queried order did not verify as payable; `verificationCode` says why. */
export interface IapOrderUnverifiedResponse extends IapOrderStatusSuccess {
  verified: false;
  verificationCode: IapVerificationCode;
}

/**
 * Result of the in-app-purchase order status query.
 *
 * `ok` means the status query itself succeeded: the provider answered with a
 * well-formed, provider-attested payload. `verified` means the provider
 * evidence confirms the requested order reached a payable status
 * (`PAYMENT_COMPLETED` or `PURCHASED`) with a matching order ID. Granting
 * decisions must gate on `verified`, not on `ok`. Stub-mode output is never
 * verified; it reports `verificationCode: "STUB_EVIDENCE"` with `stub: true`.
 *
 * Per the official API, the response `sku` and `statusDeterminedAt` are
 * optional (omitted for `MINIAPP_MISMATCH`, `NOT_FOUND`, and `ERROR`), so a
 * missing SKU never flips `verified` on its own; it is reported through
 * `skuCheck.status === "NOT_PROVIDED"` for the caller to decide. There is no
 * supplementary lookup endpoint, so incomplete evidence on a payable status
 * can only be retried through this same query.
 */
export type IapOrderStatusResponse =
  | IapOrderVerifiedResponse
  | IapOrderUnverifiedResponse
  | ProviderFailure;

export interface PromotionRewardGrantInput {
  providerRequestId?: string;
  tossUserKey?: string;
  promotionCode?: string;
  amount?: number;
  promotionAmount?: number;
  requestedAt?: number;
  providerTransactionKey?: string;
}

export type PromotionRewardGrantResponse =
  | {
      ok: true;
      providerRequestId?: string;
      providerStatus: string;
      providerTransactionKey?: string;
      grantedAt?: number;
      failureReason?: string;
    }
  | {
      ok: false;
      providerRequestId?: string;
      providerStatus: string;
      providerTransactionKey?: string;
      failureReason?: string;
      providerErrorCode?: string;
    };

export interface SmartMessageSendInput {
  tossUserKey?: string;
  userKey?: string;
  anonKey?: string;
  templateSetCode?: string;
  templateCode?: string;
  providerRequestId?: string;
  requestedAt?: number;
  context: JsonObject;
}

export interface SmartMessageBulkSendInput {
  templateSetCode?: string;
  templateCode?: string;
  providerRequestId?: string;
  requestedAt?: number;
  contextList: Array<{
    userKey?: string | number;
    tossUserKey?: string | number;
    anonKey?: string;
    context: JsonObject;
  }>;
}

type SmartMessageResponseBase = {
  providerRequestId?: string;
  providerStatus: string;
  resultType?: string;
  sentAt?: number;
  msgCount?: number;
  sentPushCount?: number;
  sentInboxCount?: number;
  sentSmsCount?: number;
  sentAlimtalkCount?: number;
  sentFriendtalkCount?: number;
  detail?: unknown;
  fail?: unknown;
  failures?: Array<{ channel: string; contentId?: string; reachedFailReason?: string }>;
  contentIds?: string[];
};

export type SmartMessageResponse =
  | (SmartMessageResponseBase & {
      ok: true;
    })
  | (SmartMessageResponseBase & {
      ok: false;
      failureReason?: string;
      providerErrorCode?: string;
      upstreamStatus?: number;
    });

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
    request(body: RawMtlsRequest): Promise<RawMtlsResponse>;
  };
  login: {
    complete(body: TossLoginCompleteInput): Promise<TossLoginCompleteResponse>;
    removeByUserKey(body: TossLoginRemoveByUserKeyInput): Promise<TossLoginRemoveByUserKeyResponse>;
  };
  iap: {
    orderStatus(body: IapOrderStatusInput): Promise<IapOrderStatusResponse>;
  };
  promotion: {
    rewardGrant(body: PromotionRewardGrantInput): Promise<PromotionRewardGrantResponse>;
  };
  smartMessage: {
    send(body: SmartMessageSendInput): Promise<SmartMessageResponse>;
    bulkSend(body: SmartMessageBulkSendInput): Promise<SmartMessageResponse>;
  };
}

export interface AppsInTossApiRpc {
  health(): Promise<HealthResponse>;
  rawMtlsRequest(body: RawMtlsRequest): Promise<RawMtlsResponse>;
  genericMtlsRequest(body: RawMtlsRequest): Promise<RawMtlsResponse>;
  tossLoginComplete(body: TossLoginCompleteInput): Promise<TossLoginCompleteResponse>;
  tossLoginRemoveByUserKey(body: TossLoginRemoveByUserKeyInput): Promise<TossLoginRemoveByUserKeyResponse>;
  iapOrderStatus(body: IapOrderStatusInput): Promise<IapOrderStatusResponse>;
  promotionRewardGrant(body: PromotionRewardGrantInput): Promise<PromotionRewardGrantResponse>;
  smartMessageSend(body: SmartMessageSendInput): Promise<SmartMessageResponse>;
  smartMessageBulkSend(body: SmartMessageBulkSendInput): Promise<SmartMessageResponse>;
}

export type TossMtlsMode = AppsInTossApiMode;
export type TossMtlsCoreOptions = AppsInTossCoreOptions;
export type TossMtlsCore = AppsInTossApiRpc;
