/**
 * Internal platform contract shared by the /rn and /webview IAP adapters.
 * Each entry point declares its own structural copy of the official SDK
 * surface (they are different npm packages with identical Domains API
 * shapes); this module is the common, platform-neutral engine boundary and
 * is never exported from a public subpath.
 */

import type {
  IapOneTimePurchaseParams,
  IapPendingOrder,
  IapProduct,
  IapSubscriptionPurchaseParams
} from "../index.js";

export interface IapSdkError {
  code?: string;
  message?: string;
}

export type IapGrantTarget = {
  orderId: string;
  sku: string;
  subscriptionId?: string;
};

/** Official SDK functions optionally expose an isSupported() pre-check. */
type WithSupport<F> = F & { isSupported?: () => boolean };

export interface IapPlatformSdk {
  getSubscriptionInfo: WithSupport<(args: { params: { orderId: string } }) => Promise<unknown>>;
  getProductItemList: WithSupport<() => Promise<{ products: IapProduct[] }>>;
  createOneTimePurchaseOrder: WithSupport<(params: IapOneTimePurchaseParams) => () => void>;
  createSubscriptionPurchaseOrder: WithSupport<
    (params: IapSubscriptionPurchaseParams) => () => void
  >;
  getPendingOrders: WithSupport<() => Promise<{ orders: IapPendingOrder[] }>>;
  completeProductGrant: WithSupport<
    (args: { params: { orderId: string } }) => Promise<boolean>
  >;
}

/**
 * Injection surface: installed framework versions may expose only some IAP
 * functions. The loaders accept any partial surface; the adapter gates each
 * operation individually at call time.
 */
export type PartialIapPlatformSdk = {
  [K in keyof IapPlatformSdk]?: IapPlatformSdk[K];
};

export type IapPlatformLoader = () => Promise<
  { available: true; module: PartialIapPlatformSdk } | { available: false; reason: string }
>;

export function toIapErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const coded = error as IapSdkError;
    if (typeof coded.message === "string" && coded.message) return coded.message;
  }
  return String(error);
}

export function toIapErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const code = (error as IapSdkError).code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}
