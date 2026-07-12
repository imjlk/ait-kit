import { getIapOrderStatus } from "./iap";
import { completeTossLogin, removeTossLoginByUserKey } from "./login";
import { rawMtlsRequest } from "./mtls-client";
import { grantPromotionReward } from "./promotion";
import { bulkSendSmartMessage, sendSmartMessage } from "./smart-message";
import { normalizeCoreOptions, stringOrUndefined } from "./toss-envelope";
import type {
  AppsInTossApi,
  AppsInTossApiRpc,
  AppsInTossCoreOptions,
  HealthResponse,
  NormalizedAppsInTossCoreOptions
} from "./types";

export * from "./types";
export * from "./mtls-client";
export * from "./toss-envelope";
export * from "./login";
export * from "./iap";
export * from "./promotion";
export * from "./smart-message";
export * from "./raw";

export function createAppsInTossApi(options: AppsInTossCoreOptions = {}): AppsInTossApi {
  const coreOptions = normalizeCoreOptions(options);
  return {
    health: async () => healthResponse(coreOptions),
    raw: {
      request: (body) => rawMtlsRequest(body, coreOptions)
    },
    login: {
      complete: (body) => completeTossLogin(body, coreOptions),
      removeByUserKey: (body) => removeTossLoginByUserKey(body, coreOptions)
    },
    iap: {
      orderStatus: (body) => getIapOrderStatus(body, coreOptions)
    },
    promotion: {
      rewardGrant: (body) => grantPromotionReward(body, coreOptions)
    },
    smartMessage: {
      send: (body) => sendSmartMessage(body, coreOptions),
      bulkSend: (body) => bulkSendSmartMessage(body, coreOptions)
    }
  };
}

export function createAppsInTossApiRpc(api: AppsInTossApi): AppsInTossApiRpc {
  return {
    health: () => api.health(),
    rawMtlsRequest: (body) => api.raw.request(body),
    genericMtlsRequest: (body) => api.raw.request(body),
    tossLoginComplete: (body) => api.login.complete(body),
    tossLoginRemoveByUserKey: (body) => api.login.removeByUserKey(body),
    iapOrderStatus: (body) => api.iap.orderStatus(body),
    promotionRewardGrant: (body) => api.promotion.rewardGrant(body),
    smartMessageSend: (body) => api.smartMessage.send(body),
    smartMessageBulkSend: (body) => api.smartMessage.bulkSend(body)
  };
}

export function createAppsInTossApiRpcFromOptions(options: AppsInTossCoreOptions = {}) {
  return createAppsInTossApiRpc(createAppsInTossApi(options));
}

export const createTossMtlsCore = createAppsInTossApiRpcFromOptions;

function healthResponse(options: NormalizedAppsInTossCoreOptions): HealthResponse {
  const hasDirectClient = Boolean(options.mtlsClient);
  const hasFactory = Boolean(options.mtlsClientFactory);
  const hasFactoryAppId = Boolean(stringOrUndefined(options.appId));
  const mtlsClient = hasDirectClient || (hasFactory && hasFactoryAppId);
  const checks = {
    mtlsClient,
    rawMtlsEnabled: options.allowRawMtls
  };

  if (options.mode === "forward" && !mtlsClient) {
    return {
      ok: false,
      ready: false,
      mode: options.mode,
      scope: "apps-in-toss-api" as const,
      error: hasFactory && !hasFactoryAppId ? "MISSING_MTLS_APP_ID" : "MISSING_MTLS_CLIENT",
      checks
    };
  }

  return {
    ok: true,
    ready: true,
    mode: options.mode,
    scope: "apps-in-toss-api" as const,
    checks
  };
}
