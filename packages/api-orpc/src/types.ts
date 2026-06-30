import type { AppsInTossApiRpc } from "@ait-kit/api-core";

export interface PublicApiContext {
  tossApi: AppsInTossApiRpc;
}

export interface CampaignJoinResult {
  ok: boolean;
  campaignId: string;
  providerStatus?: unknown;
}

