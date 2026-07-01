import { getIapOrderStatus } from "./iap";
import { completeTossLogin, removeTossLoginByUserKey } from "./login";
import { rawMtlsRequest } from "./mtls-client";
import { grantPromotionReward } from "./promotion";
import { bulkSendSmartMessage, sendSmartMessage } from "./smart-message";
import { normalizeCoreOptions } from "./toss-envelope";
import type { AppsInTossApi, AppsInTossApiRpc, AppsInTossCoreOptions } from "./types";

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
    health: async () => ({ ok: true, mode: coreOptions.mode, scope: "apps-in-toss-api" }),
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
