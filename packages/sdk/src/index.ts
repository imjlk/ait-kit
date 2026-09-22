/**
 * `@ait-kit/sdk` — shared frontend contracts for Apps in Toss mini apps.
 *
 * The root entry is runtime-neutral: common types and errors only, with no
 * imports of any official runtime SDK. Runtime adapters live in subpaths —
 * `@ait-kit/sdk/rn` for React Native and `@ait-kit/sdk/webview` for WebView.
 */

/** Reward payload reported by rewarded ad flows. */
export interface AdReward {
  unitType: string;
  unitAmount: number;
}

/**
 * Terminal outcome of showing a full-screen ad.
 *
 * `rewarded` is only ever produced from the provider's actual reward event —
 * loading, showing, or dismissing an ad never implies a reward. Server-side
 * reward verification, session checks, and ledger updates stay with the
 * consumer.
 */
export type AdShowResult =
  | { status: "rewarded"; reward: AdReward }
  | { status: "dismissed" }
  | { status: "failed"; reason?: string };

/** Stable error codes for SDK adapter failures. */
export type SdkErrorCode =
  | "SDK_UNAVAILABLE" // the official SDK module is missing or failed to load
  | "UNSUPPORTED" // the runtime/app version does not support the operation
  | "AD_NOT_LOADED" // show requested before a completed load
  | "AD_ALREADY_SHOWING" // this ad is currently being shown
  | "AD_LOAD_FAILED" // the provider rejected the load (transient; retryable)
  | "AD_LOAD_TIMEOUT" // the load flow exceeded its deadline (retryable)
  | "INVALID_BANNER_INPUT" // malformed ad group, target, or initialization timeout
  | "BANNER_INIT_TIMEOUT" // initialization exceeded its deadline (retryable)
  | "BANNER_TARGET_IN_USE" // another live handle owns this target until destroyed
  | "BANNER_ATTACH_FAILED" // the provider rejected or failed attachment
  | "INVALID_IAP_INPUT" // malformed IAP query input
  | "INVALID_IAP_RESULT" // the SDK returned a malformed IAP query result
  | "INVALID_LOGIN_RESULT" // the SDK resolved a login result that failed validation
  | "INVALID_ANONYMOUS_KEY" // the SDK resolved an anonymous key that failed validation
  | "INVALID_PROMOTION_INPUT" // malformed direct grant input or timeout
  | "PROMOTION_IN_PROGRESS" // this instance still has an unsettled direct grant
  | "INVALID_SHARE_PATH"; // a share link path was not an intoss:// deeplink

// ---------------------------------------------------------------------------
// Notification agreement / sharing contracts (adapters live in /rn, /webview)
// ---------------------------------------------------------------------------

/** Terminal agreement outcomes delivered by the platform event. */
export type SdkNotificationAgreementType = "newAgreement" | "alreadyAgreed" | "agreementRejected";

/**
 * Result of one notification agreement request. `templateCode` and the
 * platform's raw event are preserved verbatim, and the outcome describes
 * ONLY this single request — it is not the user's global notification
 * setting, nor any server-persisted consent state (syncing those is the
 * consumer's job).
 */
export type SdkNotificationAgreementResult =
  | {
      status: "agreed";
      agreement: Exclude<SdkNotificationAgreementType, "agreementRejected">;
      templateCode: string;
      sourceEvent: { type: string };
    }
  | { status: "rejected"; templateCode: string; sourceEvent: { type: string } }
  | { status: "failed"; templateCode: string; code?: string; reason?: string }
  | { status: "timeout"; templateCode: string; reason?: string };

/**
 * Result of opening the share UI. `completed` means ONLY that the SDK share
 * call finished — it does NOT prove the share sheet opened or closed, that
 * the user actually shared, and it never grants share-reward eligibility.
 * (Renamed from `closed` in 0.3.0: the underlying SDKs guarantee the call
 * completing, not the sheet's lifecycle.)
 */
export type SdkShareUiResult =
  | { status: "completed" }
  | { status: "failed"; code?: string; reason?: string };

// --------------------------------------------------------------------------
// Login / anonymous identity / storage contracts (adapters live in /rn, /webview)
// --------------------------------------------------------------------------

export type SdkLoginReferrer = "DEFAULT" | "SANDBOX";

/**
 * Validated login result. Both values come from the platform SDK and pass
 * through unchanged: exchange `authorizationCode` for tokens on YOUR server
 * (see @ait-kit/api-core's login token endpoint) and create the application
 * session there — the SDK adapter never performs the exchange.
 */
export interface SdkLoginResult {
  authorizationCode: string;
  referrer: SdkLoginReferrer;
}

/**
 * Validated anonymous identity: the SDK-issued per-mini-app hash. The
 * adapter never fabricates a key when the SDK cannot provide one — a
 * missing or malformed result is an error, not a placeholder.
 */
export interface SdkAnonymousKey {
  type: "HASH";
  hash: string;
}

/** Minimal storage contract shared by the /rn and /webview adapters. */
export interface SdkStorage {
  /** Resolves the stored string, or null when the key has no value. */
  get(key: string): Promise<string | null>;
  /** Persists a string; rejections propagate to the caller. */
  set(key: string, value: string): Promise<void>;
  /** Removes the value for a key; rejections propagate to the caller. */
  remove(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-app purchase contracts (runtime-neutral; adapters live in /rn and /webview)
// ---------------------------------------------------------------------------

export type IapProductType = "CONSUMABLE" | "NON_CONSUMABLE" | "SUBSCRIPTION";
export type IapSubscriptionRenewalCycle = "WEEKLY" | "MONTHLY" | "YEARLY";

export interface IapSubscriptionOffer {
  type: "FREE_TRIAL" | "NEW_SUBSCRIPTION" | "RETURNING";
  offerId: string;
  period: string;
  displayAmount?: string;
}

export interface IapProduct {
  sku: string;
  type: IapProductType;
  displayName: string;
  displayAmount: string;
  iconUrl: string;
  description: string;
  /** Subscription products only. */
  renewalCycle?: IapSubscriptionRenewalCycle;
  offers?: IapSubscriptionOffer[];
}

export interface IapPendingOrder {
  orderId: string;
  sku: string;
  paymentCompletedDate: string;
}

/** Success payload delivered by the platform's purchase success event. */
export interface IapPurchaseSuccessInfo {
  orderId: string;
  displayName: string;
  displayAmount: string;
  amount: number;
  currency: string;
  fraction: number;
  miniAppIconUrl: string | null;
}

/**
 * Consumer-injected server grant callback.
 *
 * Contract: resolve only AFTER your server has verified the order with the
 * provider and persisted the grant. Resolving on the SDK event alone (or
 * before persistence) breaks the purchase contract; rejecting or throwing
 * marks the grant as failed and the purchase never reports completion.
 * Server-side verification is the consumer's responsibility — SDK events
 * are not payment verification.
 */
export type IapGrantCallback = (target: {
  orderId: string;
  sku: string;
  subscriptionId?: string;
}) => Promise<void>;

/**
 * Terminal outcome of a purchase flow. `completed` requires BOTH the
 * platform's success event for the order AND your grant callback having
 * resolved for that exact order — a grant for a different order never
 * completes a purchase, and a success event alone never completes one.
 */
export type IapPurchaseResult =
  | { status: "completed"; orderId: string; subscriptionId?: string; success: IapPurchaseSuccessInfo }
  | { status: "canceled" }
  | { status: "failed"; code?: string; reason?: string }
  | { status: "grant_failed"; orderId: string; reason?: string }
  | { status: "unknown"; orderId?: string; subscriptionId?: string; reason?: string };

// Platform purchase-order parameter shapes (structural mirrors of the
// official Domains API, shared by the /rn and /webview connectors).

export interface IapGrantOrderParams {
  orderId: string;
  subscriptionId?: string;
}

export interface IapOneTimePurchaseParams {
  options: {
    sku: string;
    processProductGrant: (params: IapGrantOrderParams) => boolean | Promise<boolean>;
  };
  onEvent: (event: { type: "success"; data: IapPurchaseSuccessInfo }) => void | Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
}

export interface IapSubscriptionPurchaseParams {
  options: {
    sku: string;
    offerId?: string | null;
    processProductGrant: (params: IapGrantOrderParams) => boolean | Promise<boolean>;
  };
  onEvent: (event: { type: "success"; data: IapPurchaseSuccessInfo }) => void | Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
}

/** Typed error surfaced by the SDK adapters. */
export class SdkError extends Error {
  code: SdkErrorCode;

  constructor(code: SdkErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SdkError";
    this.code = code;
  }
}

export type { ReviewAdapter } from "./review/platform-contract.js";

export type { PromotionAdapter, PromotionSupport, PromotionGrantInput, PromotionGrantResult } from "./promotion/platform-contract.js";

/** Provider subscription state; unknown future states are preserved without inference. */
export type IapSubscriptionStatus = "ACTIVE" | "EXPIRED" | "IN_GRACE_PERIOD" | "ON_HOLD" | "PAUSED" | "REVOKED" | (string & {});

/** Provider snapshot only; server verification remains the source of entitlement decisions. */
export interface IapSubscriptionInfo {
  catalogId: number;
  status: IapSubscriptionStatus;
  expiresAt: string | null;
  isAutoRenew: boolean;
  gracePeriodExpiresAt: string | null;
  isAccessible: boolean;
}

/** One completed purchase or refund reported by the provider. */
export interface IapCompletedOrRefundedOrder {
  orderId: string;
  sku: string;
  status: "COMPLETED" | "REFUNDED";
  date: string;
}
export interface IapOrderHistoryPage {
  orders: IapCompletedOrRefundedOrder[];
  hasNext: boolean;
  nextKey?: string | null;
  /** WebView currently exposes only the first page, even when hasNext is true. */
  pagination: "cursor" | "first_page_only";
}
