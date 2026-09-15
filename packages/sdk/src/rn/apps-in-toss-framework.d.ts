/**
 * Ambient declaration for the optional peer `@apps-in-toss/framework`,
 * written from the published Ads documentation. It lets this package and
 * its consumers type-check without installing the official SDK; at
 * runtime the loader imports the real module lazily and reports
 * SDK_UNAVAILABLE when it is absent.
 */
declare module "@apps-in-toss/framework" {
  import type { FullScreenAdSupport } from "./framework-contract.js";
  import type { IapPlatformSdk } from "../iap/platform-contract.js";

  export const loadFullScreenAd: FullScreenAdSupport["loadFullScreenAd"];
  export const showFullScreenAd: FullScreenAdSupport["showFullScreenAd"];
  export const IAP: IapPlatformSdk;
}
