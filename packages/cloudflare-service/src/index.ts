import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  AppsInTossApiRpc,
  HealthResponse,
  IapOrderStatusInput,
  IapOrderStatusResponse,
  PromotionRewardGrantInput,
  PromotionRewardGrantResponse,
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
import { createServiceRpc, type AppsInTossServiceEnv } from "./context";
import { handleFetchFallback } from "./fetch-fallback";
import { createCloudflareMtlsClient } from "./mtls";

export class AppsInTossApiService extends WorkerEntrypoint<AppsInTossServiceEnv> implements AppsInTossApiRpc {
  fetch(request: Request): Promise<Response> {
    return handleFetchFallback(request, this.rpc());
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

  async promotionRewardGrant(body: PromotionRewardGrantInput): Promise<PromotionRewardGrantResponse> {
    return this.rpc().promotionRewardGrant(body);
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
