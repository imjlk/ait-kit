export type PromotionSupport = "supported" | "unsupported" | "unknown";

export interface PromotionGrantInput {
  promotionCode: string;
  amount: number;
}

export type PromotionGrantResult =
  | { status: "granted"; rewardKey: string }
  | { status: "rejected"; providerCode: string }
  | {
      status: "unknown";
      reason: "sdk_error" | "timeout" | "invalid_response" | "ambiguous_provider_error";
      providerCode?: string;
    };

/** Client SDK reports are not independently verified server ledger evidence. */
export interface PromotionAdapter {
  getSupport(): Promise<PromotionSupport>;
  grantReward(input: PromotionGrantInput): Promise<PromotionGrantResult>;
}

/** Injected results are untrusted, just like the native bridge response. */
export interface PromotionPlatformSdk {
  Promotion?: {
    grantReward?: ((input: PromotionGrantInput) => Promise<unknown>) & {
      isSupported?: () => boolean;
    };
  };
}

export type PromotionPlatformLoader = () => Promise<
  | { available: true; module: PromotionPlatformSdk }
  | { available: false; reason: string }
>;
