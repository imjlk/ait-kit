import { WorkerEntrypoint } from "cloudflare:workers";
import type { AppsInTossApiRpc, HealthResponse, RawMtlsResponse } from "@ait-kit/api-core";
import { createServiceRpc, type AppsInTossServiceEnv } from "./context";
import { handleFetchFallback } from "./fetch-fallback";
import { createCloudflareMtlsClient } from "./mtls";

export class AppsInTossApiService extends WorkerEntrypoint<AppsInTossServiceEnv> implements AppsInTossApiRpc {
  async health(): Promise<HealthResponse> {
    return this.rpc().health();
  }

  async rawMtlsRequest(body: unknown): Promise<RawMtlsResponse> {
    return this.rpc().rawMtlsRequest(body);
  }

  async genericMtlsRequest(body: unknown): Promise<RawMtlsResponse> {
    return this.rpc().genericMtlsRequest(body);
  }

  async tossLoginComplete(body: unknown): Promise<unknown> {
    return this.rpc().tossLoginComplete(body);
  }

  async tossLoginRemoveByUserKey(body: unknown): Promise<unknown> {
    return this.rpc().tossLoginRemoveByUserKey(body);
  }

  async iapOrderStatus(body: unknown): Promise<unknown> {
    return this.rpc().iapOrderStatus(body);
  }

  async promotionRewardGrant(body: unknown): Promise<unknown> {
    return this.rpc().promotionRewardGrant(body);
  }

  async smartMessageSend(body: unknown): Promise<unknown> {
    return this.rpc().smartMessageSend(body);
  }

  async smartMessageBulkSend(body: unknown): Promise<unknown> {
    return this.rpc().smartMessageBulkSend(body);
  }

  private rpc(): AppsInTossApiRpc {
    return createServiceRpc(this.env);
  }
}

export type AppsInTossApiServiceBinding = AppsInTossApiRpc;
export type { AppsInTossServiceEnv };
export { createServiceRpc, createCloudflareMtlsClient, handleFetchFallback };

export default {
  fetch(request: Request, env: AppsInTossServiceEnv) {
    return handleFetchFallback(request, createServiceRpc(env));
  }
} satisfies ExportedHandler<AppsInTossServiceEnv>;
