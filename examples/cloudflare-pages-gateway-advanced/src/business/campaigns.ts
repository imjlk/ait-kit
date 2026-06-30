import type { PagesGatewayEnv } from "../types";

export interface JoinCampaignInput {
  campaignId: string;
  tossUserKey: string;
  providerRequestId?: string;
  promotionCode?: string;
  amount?: number;
}

export async function joinCampaign(env: PagesGatewayEnv, input: JoinCampaignInput) {
  return env.APPS_IN_TOSS_API.promotionRewardGrant({
    providerRequestId: input.providerRequestId ?? input.campaignId,
    tossUserKey: input.tossUserKey,
    promotionCode: input.promotionCode,
    amount: input.amount
  });
}

