import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AnonKeyVerifyInput,
  AnonKeyVerifyResponse,
  AppsInTossApiRpc,
  HealthResponse,
  IapOrderStatusInput,
  IapOrderStatusResponse,
  PromotionRewardExecuteInput,
  PromotionRewardExecuteResponse,
  PromotionRewardGrantInput,
  PromotionRewardGrantResponse,
  PromotionRewardPrepareInput,
  PromotionRewardPrepareResponse,
  PromotionRewardStatusInput,
  PromotionRewardStatusResponse,
  RawMtlsRequest,
  RawMtlsResponse,
  SmartMessageBulkSendInput,
  SmartMessageResponse,
  SmartMessageSendInput,
  TossLoginCompleteInput,
  TossLoginCompleteResponse,
  TossLoginRemoveByUserKeyInput,
  TossLoginRemoveByUserKeyResponse
} from "@ait-kit/api-core";
import { createServiceRpc, type AppsInTossServiceEnv } from "./context.js";
import { handleFetchFallback } from "./fetch-fallback.js";
import { createCloudflareMtlsClient } from "./mtls.js";

export class AppsInTossApiService extends WorkerEntrypoint<AppsInTossServiceEnv> implements AppsInTossApiRpc {
  fetch(request: Request): Promise<Response> {
    return handleFetchFallback(request, this.rpc(), {
      bearerToken: this.env.TOSS_HTTP_BEARER_TOKEN
    });
  }

  async health(): Promise<HealthResponse> {
    return this.rpc().health();
  }

  async rawMtlsRequest(body: RawMtlsRequest): Promise<RawMtlsResponse> {
    return this.rpc().rawMtlsRequest(body);
  }

  async genericMtlsRequest(body: RawMtlsRequest): Promise<RawMtlsResponse> {
    return this.rpc().genericMtlsRequest(body);
  }

  async tossLoginComplete(body: TossLoginCompleteInput): Promise<TossLoginCompleteResponse> {
    return this.rpc().tossLoginComplete(body);
  }

  async tossLoginRemoveByUserKey(body: TossLoginRemoveByUserKeyInput): Promise<TossLoginRemoveByUserKeyResponse> {
    return this.rpc().tossLoginRemoveByUserKey(body);
  }

  async iapOrderStatus(body: IapOrderStatusInput): Promise<IapOrderStatusResponse> {
    return this.rpc().iapOrderStatus(body);
  }

  async verifyAnonKey(body: AnonKeyVerifyInput): Promise<AnonKeyVerifyResponse> {
    return this.rpc().verifyAnonKey(body);
  }

  async promotionRewardGrant(body: PromotionRewardGrantInput): Promise<PromotionRewardGrantResponse> {
    return this.rpc().promotionRewardGrant(body);
  }

  async promotionPrepareReward(body: PromotionRewardPrepareInput): Promise<PromotionRewardPrepareResponse> {
    return this.rpc().promotionPrepareReward(body);
  }

  async promotionExecuteReward(body: PromotionRewardExecuteInput): Promise<PromotionRewardExecuteResponse> {
    return this.rpc().promotionExecuteReward(body);
  }

  async promotionRewardStatus(body: PromotionRewardStatusInput): Promise<PromotionRewardStatusResponse> {
    return this.rpc().promotionRewardStatus(body);
  }

  async smartMessageSend(body: SmartMessageSendInput): Promise<SmartMessageResponse> {
    return this.rpc().smartMessageSend(body);
  }

  async smartMessageBulkSend(body: SmartMessageBulkSendInput): Promise<SmartMessageResponse> {
    return this.rpc().smartMessageBulkSend(body);
  }

  private rpc(): AppsInTossApiRpc {
    return createServiceRpc(this.env);
  }
}

export type AppsInTossApiServiceBinding = AppsInTossApiRpc;
export type { AppsInTossServiceEnv };
export { createServiceRpc, createCloudflareMtlsClient, handleFetchFallback };

export default AppsInTossApiService;
