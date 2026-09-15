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
  anonKeyVerify: "/api-partner/v1/apps-in-toss/users/anon-key/verify",
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

/**
 * Input for the explicit promotion prepare step. The official get-key
 * endpoint takes no body and no recipient header (mTLS identifies the app).
 */
export interface PromotionRewardPrepareInput {}

/**
 * Input for the explicit promotion execute step. `providerTransactionKey`
 * (from prepare, stored by the consumer) is required — execute never issues
 * a new key. The recipient fields follow the shared recipient contract:
 * exactly one of `userKey`, `tossUserKey`, or `anonKey`.
 */
export interface PromotionRewardExecuteInput {
  providerTransactionKey?: string;
  promotionCode?: string;
  amount?: number;
  userKey?: string | number;
  tossUserKey?: string | number;
  anonKey?: string;
}

/**
 * Input for the explicit promotion status step. Only reads the recorded
 * outcome for an existing transaction key; never issues keys or executes
 * grants.
 */
export interface PromotionRewardStatusInput {
  providerTransactionKey?: string;
  promotionCode?: string;
  userKey?: string | number;
  tossUserKey?: string | number;
  anonKey?: string;
}

/**
 * Result of the promotion prepare step (get-key only).
 *
 * `providerTransactionKey` is the encrypted key the provider requires for
 * execute and status. Persist it before executing; key expiry is not
 * documented by the official contract.
 */
export type PromotionRewardPrepareResponse =
  | {
      ok: true;
      providerTransactionKey: string;
      /** Synthetic stub-mode output; never present in forward mode. */
      stub?: true;
    }
  | ProviderFailure;

/**
 * Result of the promotion execute step.
 *
 * - `SUBMITTED` — the provider accepted the grant request. This is not the
 *   final grant state; confirm with the status step.
 * - `UNKNOWN` (`ok: true`) — the request may or may not have been applied
 *   (transport failure, unparseable response). The transaction key is always
 *   preserved so the outcome can be resolved with the status step. Do not
 *   treat this as a definite failure, and do not automatically re-execute:
 *   the official contract documents error 4113 ("already granted/retracted")
 *   for same-key re-execution but does not guarantee idempotency.
 * - `ok: false` — the provider explicitly rejected this execute call (FAIL
 *   envelope such as 4100/4105/4108/4109/4110/4112/4113/4114, or a 4xx
 *   response; 5xx responses stay UNKNOWN).
 *
 * Passing a `providerRequestId`-style identifier does not by itself make an
 * external grant idempotent.
 */
export type PromotionRewardExecuteResponse =
  | {
      ok: true;
      result: "SUBMITTED";
      providerTransactionKey: string;
      stub?: true;
    }
  | {
      ok: true;
      result: "UNKNOWN";
      providerTransactionKey: string;
      failureReason?: string;
      providerErrorCode?: string;
      upstreamStatus?: number;
      stub?: true;
    }
  | {
      ok: false;
      providerTransactionKey: string;
      providerStatus: "FAILED";
      failureReason: string;
      providerErrorCode?: string;
      upstreamStatus?: number;
    };

/**
 * Observed status of a promotion transaction key.
 *
 * - `GRANTED` — explicit provider success (`SUCCESS`).
 * - `PENDING` — accepted, still processing.
 * - `FAILED` — explicit provider failure; the provider documents that the
 *   used budget was rolled back.
 * - `NOT_FOUND` — the provider answered error 4111: no grant record exists
 *   for this key (never executed, or the record is gone).
 * - `UNKNOWN` — no verdict: transport failure, non-2xx, or an unparseable
 *   response. Never treat this as a definite failure.
 *
 * The official API supplies no grant timestamp, so responses carry
 * `checkedAt` (observation time) and never a fabricated `grantedAt`.
 */
export type PromotionRewardStatus =
  | "GRANTED"
  | "PENDING"
  | "FAILED"
  | "NOT_FOUND"
  | "UNKNOWN";

export type PromotionRewardStatusResponse = {
  ok: true;
  status: PromotionRewardStatus;
  providerTransactionKey: string;
  checkedAt: number;
  failureReason?: string;
  providerErrorCode?: string;
  upstreamStatus?: number;
  /** Synthetic stub-mode output; never present in forward mode. */
  stub?: true;
};

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

/**
 * Input for the anonymous key verification API.
 *
 * The official endpoint receives the key in the `x-anon-key` request header
 * and carries the raw value through unchanged; see {@link AnonKeyVerifyResponse}.
 */
export interface AnonKeyVerifyInput {
  anonKey?: string;
}

/**
 * Result of verifying an anonymous key against the provider.
 *
 * `ok: true` with `valid` is a definitive provider verdict: `valid: true`
 * means the key is recognized, `valid: false` means the provider evaluated
 * the key and considers it invalid. `ok: false` (ProviderFailure) means no
 * verdict could be obtained — transport failures, HTTP 5xx/4xx, FAIL
 * envelopes (including errorCode 4010 "auth info not found"), or malformed
 * responses. Callers must not translate `ok: false` into `valid: false`.
 *
 * Stub-mode output is synthetic (`stub: true`) and never provider evidence.
 */
export type AnonKeyVerifyResponse =
  | {
      ok: true;
      valid: boolean;
      /** Synthetic stub-mode output; never present in forward mode. */
      stub?: true;
    }
  | ProviderFailure;

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
  /**
   * `SENT` — delivery confirmed by send-result evidence. `FAILED` — the
   * provider definitively rejected or failed the send (failure entries /
   * error envelope / 4xx). `UNKNOWN` — the outcome could not be determined
   * (malformed or evidence-free response, 5xx, NETWORK_ERROR/TIMEOUT
   * envelopes): the message may or may not have been delivered; resolve out
   * of band, never auto-resend on this signal alone.
   */
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
      /**
       * Internal parsing/validation marker (e.g. "INVALID_RESPONSE"): the
       * response body could not be interpreted as a send result. Distinct
       * from `providerErrorCode`, which mirrors a code the provider
       * actually returned.
       */
      error?: string;
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
  users: {
    verifyAnonKey(body: AnonKeyVerifyInput): Promise<AnonKeyVerifyResponse>;
  };
  promotion: {
    rewardGrant(body: PromotionRewardGrantInput): Promise<PromotionRewardGrantResponse>;
    prepareReward(body: PromotionRewardPrepareInput): Promise<PromotionRewardPrepareResponse>;
    executeReward(body: PromotionRewardExecuteInput): Promise<PromotionRewardExecuteResponse>;
    rewardStatus(body: PromotionRewardStatusInput): Promise<PromotionRewardStatusResponse>;
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
  verifyAnonKey(body: AnonKeyVerifyInput): Promise<AnonKeyVerifyResponse>;
  promotionRewardGrant(body: PromotionRewardGrantInput): Promise<PromotionRewardGrantResponse>;
  promotionPrepareReward(body: PromotionRewardPrepareInput): Promise<PromotionRewardPrepareResponse>;
  promotionExecuteReward(body: PromotionRewardExecuteInput): Promise<PromotionRewardExecuteResponse>;
  promotionRewardStatus(body: PromotionRewardStatusInput): Promise<PromotionRewardStatusResponse>;
  smartMessageSend(body: SmartMessageSendInput): Promise<SmartMessageResponse>;
  smartMessageBulkSend(body: SmartMessageBulkSendInput): Promise<SmartMessageResponse>;
}

export type TossMtlsMode = AppsInTossApiMode;
export type TossMtlsCoreOptions = AppsInTossCoreOptions;
export type TossMtlsCore = AppsInTossApiRpc;
