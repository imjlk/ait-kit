/**
 * `@ait-kit/sdk` — shared frontend contracts for Apps in Toss mini apps.
 *
 * The root entry is runtime-neutral: common types and errors only, with no
 * imports of any official runtime SDK. Runtime adapters live in subpaths —
 * `@ait-kit/sdk/rn` for React Native (ads today; more domains later).
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
  | "AD_NOT_LOADED" // show requested before a successful load
  | "AD_ALREADY_LOADING" // a load is already in flight for this ad
  | "AD_ALREADY_SHOWING"; // this ad is currently being shown

/** Typed error surfaced by the SDK adapters. */
export class SdkError extends Error {
  code: SdkErrorCode;

  constructor(code: SdkErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SdkError";
    this.code = code;
  }
}
