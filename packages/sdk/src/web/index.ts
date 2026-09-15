/**
 * Web adapters for `@ait-kit/sdk`.
 *
 * Requires the official `@apps-in-toss/web-framework` package (declared as
 * an optional peer): it is imported lazily at first use, so this entry
 * never requires the React Native SDK, and the React Native entry never
 * requires this one.
 *
 * ```ts
 * import { createWebIap } from "@ait-kit/sdk/web";
 *
 * const iap = createWebIap({
 *   // Resolve only after YOUR server verified the order and persisted the
 *   // grant (see the ait-kit server packages for verification flows).
 *   grant: async ({ orderId, sku }) => {
 *     await fetch("/api/iap/grant", { method: "POST", body: JSON.stringify({ orderId, sku }) });
 *   }
 * });
 * const result = await iap.purchaseOneTime("SKU_100_COINS");
 * ```
 */
import { createIapAdapter, type IapAdapterOptions, type IapRecoveryResult } from "../iap/adapter.js";
import type { IapPlatformLoader } from "../iap/platform-contract.js";
import { createDefaultWebFrameworkLoader } from "./framework-loader.js";
import type { WebIapFramework } from "./iap-contract.js";

export interface WebIapOptions extends Omit<IapAdapterOptions, "loader"> {
  /**
   * Web framework injection: pass an `IAP` module instance or a custom
   * loader (tests/consumers). Defaults to the lazy
   * `import("@apps-in-toss/web-framework")` loader.
   */
  framework?: WebIapFramework["IAP"] | IapPlatformLoader;
}

export type WebIap = ReturnType<typeof createWebIap>;
export type { IapRecoveryResult };

export function createWebIap(options: WebIapOptions) {
  const loader: IapPlatformLoader = !options.framework
    ? createDefaultWebFrameworkLoader()
    : typeof options.framework === "function"
      ? options.framework
      : async () => ({ available: true, module: options.framework as WebIapFramework["IAP"] });
  return createIapAdapter({ ...options, loader });
}
