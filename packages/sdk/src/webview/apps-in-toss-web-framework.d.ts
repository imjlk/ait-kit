/**
 * Ambient declaration for the optional peer `@apps-in-toss/web-framework`,
 * written from the published documentation and verified against the
 * official 3.4.0 type declarations. The web SDK exposes the identity,
 * notification, and share capabilities under the same namespaced shape as
 * the shared platform contracts, so the web loaders consume it directly.
 */
declare module "@apps-in-toss/web-framework" {
  import type { WebViewIapFramework } from "./iap-contract.js";
  import type { NotificationAgreementParams } from "../notification/platform-contract.js";

  export const Promotion: {
    grantReward: ((input: { promotionCode: string; amount: number }) => Promise<{ key: string }>) & { isSupported: () => boolean };
  };
  export const Review: { request: (() => Promise<void>) & { isSupported: () => boolean } };
  export const IAP: WebViewIapFramework["IAP"];
  export const TossAuth: {
    login: () => Promise<{ authorizationCode: string; referrer: "DEFAULT" | "SANDBOX" }>;
  };
  export const User: {
    getAnonymousKey: (() => Promise<{ type: "HASH"; hash: string }>) & {
      isSupported?: () => boolean;
    };
  };
  export const Notification: {
    requestAgreement: ((params: NotificationAgreementParams) => () => void) & {
      isSupported?: () => boolean;
    };
  };
  export const Share: {
    createLink: (params: { path: string; ogImageUrl?: string }) => Promise<string>;
    sendMessage: (message: { message: string }) => Promise<void>;
  };
  export const Storage: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  };
}
