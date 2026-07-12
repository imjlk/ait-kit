import type { AppsInTossApiRpc } from "@ait-kit/api-core";

export interface JoinCampaignInput {
  campaignId: string;
  tossUserKey: string;
  providerRequestId?: string;
  promotionCode?: string;
  amount?: number;
}

export async function joinCampaign(tossApi: AppsInTossApiRpc, input: JoinCampaignInput) {
  return tossApi.promotionRewardGrant({
    providerRequestId: input.providerRequestId ?? input.campaignId,
    tossUserKey: input.tossUserKey,
    promotionCode: input.promotionCode,
    amount: input.amount
  });
}
