/**
 * Ambient declaration for the optional peer `@apps-in-toss/framework`,
 * written from the published documentation and verified against the
 * official 2.10.10 type declarations. It lets this package and its
 * consumers type-check without installing the official SDK; at runtime the
 * loaders import the real module lazily and report SDK_UNAVAILABLE when it
 * is absent.
 *
 * The identity/notification/share exports below are the official flat
 * functions; `src/rn/official-module.ts` converts them to the shared
 * platform contracts at load time.
 */
declare module "@apps-in-toss/framework" {
  import type { FullScreenAdSupport } from "./framework-contract.js";
  import type { IapPlatformSdk } from "../iap/platform-contract.js";
  import type { StoragePlatformSdk } from "../storage/platform-contract.js";
  import type { OfficialRnFrameworkModule } from "./official-module.js";

  export const loadFullScreenAd: FullScreenAdSupport["loadFullScreenAd"];
  export const showFullScreenAd: FullScreenAdSupport["showFullScreenAd"];
  export const IAP: IapPlatformSdk;
  export const Storage: StoragePlatformSdk["Storage"];
  export const appLogin: NonNullable<OfficialRnFrameworkModule["appLogin"]>;
  export const getAnonymousKey: NonNullable<OfficialRnFrameworkModule["getAnonymousKey"]>;
  export const requestNotificationAgreement: NonNullable<
    OfficialRnFrameworkModule["requestNotificationAgreement"]
  >;
  export const getTossShareLink: NonNullable<OfficialRnFrameworkModule["getTossShareLink"]>;
  export const grantPromotionReward: NonNullable<OfficialRnFrameworkModule["grantPromotionReward"]>;
  export const requestReview: NonNullable<OfficialRnFrameworkModule["requestReview"]>;
  export const share: NonNullable<OfficialRnFrameworkModule["share"]>;
}
