/**
 * Ambient declaration for the optional peer `@apps-in-toss/web-framework`,
 * written from the published IAP documentation. It lets /web consumers
 * type-check without installing the official web SDK; the runtime loader
 * imports the real module lazily and reports SDK_UNAVAILABLE when absent.
 */
declare module "@apps-in-toss/web-framework" {
  import type { WebIapFramework } from "./iap-contract.js";

  export const IAP: WebIapFramework["IAP"];
}
