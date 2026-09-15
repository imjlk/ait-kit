import type { IapPlatformSdk } from "../iap/platform-contract.js";

/**
 * Structural contract for the official `@apps-in-toss/web-framework` IAP
 * domain, declared from the published documentation so /web consumers
 * type-check without the official web SDK installed. It is intentionally
 * independent of the /rn contract — neither entry requires the other
 * platform's package, in JavaScript or in generated declarations.
 */
export type WebIapModule = IapPlatformSdk;

export type WebIapFramework = {
  IAP: WebIapModule;
};
