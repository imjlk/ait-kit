import { createAppsInTossApi, createAppsInTossApiRpc, parseNonNegativeInteger, parsePositiveInteger } from "@ait-kit/api-core";
import type { AppsInTossApiRpc, AppsInTossApiMode } from "@ait-kit/api-core";
import { createCloudflareMtlsClient, type CloudflareFetcher } from "./mtls";

export interface AppsInTossServiceEnv {
  TOSS_CERT?: CloudflareFetcher;
  TOSS_API_MODE?: AppsInTossApiMode | string;
  TOSS_API_BASE_URL?: string;
  TOSS_ALLOW_RAW_MTLS?: string;
  TOSS_HTTP_BEARER_TOKEN?: string;
  TOSS_APP_ID?: string;
  TOSS_PROMOTION_CODE?: string;
  TOSS_PROMOTION_AMOUNT?: string;
  TOSS_IAP_ORDER_STATUS_MAX_ATTEMPTS?: string;
  TOSS_IAP_ORDER_STATUS_RETRY_DELAY_MS?: string;
  TOSS_API_DEBUG?: string;
}

export function createServiceRpc(env: AppsInTossServiceEnv): AppsInTossApiRpc {
  const mode = env.TOSS_API_MODE || "stub";
  return createAppsInTossApiRpc(
    createAppsInTossApi({
      mode,
      upstreamBaseUrl: env.TOSS_API_BASE_URL,
      mtlsClient: env.TOSS_CERT ? createCloudflareMtlsClient(env.TOSS_CERT) : undefined,
      allowRawMtls: env.TOSS_ALLOW_RAW_MTLS === "1" || env.TOSS_ALLOW_RAW_MTLS === "true",
      appId: env.TOSS_APP_ID,
      tossPromotionCode: env.TOSS_PROMOTION_CODE,
      tossPromotionAmount: env.TOSS_PROMOTION_AMOUNT ? parsePositiveInteger(env.TOSS_PROMOTION_AMOUNT, 0) : undefined,
      iapOrderStatusMaxAttempts: env.TOSS_IAP_ORDER_STATUS_MAX_ATTEMPTS
        ? parsePositiveInteger(env.TOSS_IAP_ORDER_STATUS_MAX_ATTEMPTS, 6)
        : undefined,
      iapOrderStatusRetryDelayMs: env.TOSS_IAP_ORDER_STATUS_RETRY_DELAY_MS
        ? parseNonNegativeInteger(env.TOSS_IAP_ORDER_STATUS_RETRY_DELAY_MS, 350)
        : undefined,
      debug: env.TOSS_API_DEBUG === "1" || env.TOSS_API_DEBUG === "true",
      log: (message, fields) => console.info("[ait-kit-api-service]", message, fields)
    })
  );
}
