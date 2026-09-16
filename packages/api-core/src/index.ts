import { verifyAnonKey } from "./anon-key.js";
import { getIapOrderStatus } from "./iap.js";
import { completeTossLogin, removeTossLoginByUserKey } from "./login.js";
import { rawMtlsRequest } from "./mtls-client.js";
import {
  executePromotionReward,
  grantPromotionReward,
  preparePromotionReward,
  statusPromotionReward
} from "./promotion.js";
import { bulkSendSmartMessage, sendSmartMessage } from "./smart-message.js";
import { normalizeCoreOptions, stringOrUndefined } from "./toss-envelope.js";
import type {
  AppsInTossApi,
  AppsInTossApiRpc,
  AppsInTossCoreOptions,
  HealthResponse,
  NormalizedAppsInTossCoreOptions
} from "./types.js";

export * from "./types.js";
export * from "./mtls-client.js";
export * from "./toss-envelope.js";
export * from "./recipient.js";
export * from "./login.js";
export * from "./iap.js";
export * from "./anon-key.js";
export * from "./promotion.js";
export * from "./smart-message.js";
export * from "./raw.js";

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
    users: {
      verifyAnonKey: (body) => verifyAnonKey(body, coreOptions)
    },
    promotion: {
      rewardGrant: (body) => grantPromotionReward(body, coreOptions),
      prepareReward: (body) => preparePromotionReward(body, coreOptions),
      executeReward: (body) => executePromotionReward(body, coreOptions),
      rewardStatus: (body) => statusPromotionReward(body, coreOptions)
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
    verifyAnonKey: (body) => api.users.verifyAnonKey(body),
    promotionRewardGrant: (body) => api.promotion.rewardGrant(body),
    promotionPrepareReward: (body) => api.promotion.prepareReward(body),
    promotionExecuteReward: (body) => api.promotion.executeReward(body),
    promotionRewardStatus: (body) => api.promotion.rewardStatus(body),
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
