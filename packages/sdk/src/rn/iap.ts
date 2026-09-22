import { resolvePlatformLoader } from "../platform-loader.js";
import { createRnPlatformLoader } from "./platform-loader.js";
import { createIapAdapter, type IapAdapterOptions, type IapRecoveryResult } from "../iap/adapter.js";
import type { IapPlatformLoader, PartialIapPlatformSdk } from "../iap/platform-contract.js";

/**
 * IAP adapter for React Native over the official `@apps-in-toss/framework`
 * (optional peer, imported lazily). The contract mirrors the web entry; the
 * two entries share the internal engine but never each other's SDK.
 */
export interface ReactNativeIapOptions extends Omit<IapAdapterOptions, "loader" | "orderHistoryPagination"> {
  /**
   * Framework injection: pass an `IAP` module instance or a custom loader
   * (tests/consumers). Defaults to the lazy
   * `import("@apps-in-toss/framework")` loader.
   */
  framework?: PartialIapPlatformSdk | IapPlatformLoader;
}

export type ReactNativeIap = ReturnType<typeof createReactNativeIap>;
export type { IapRecoveryResult };

export function createReactNativeIap(options: ReactNativeIapOptions) {
  const loader = resolvePlatformLoader(options.framework, createDefaultRnIapLoader);
  return createIapAdapter({ ...options, loader, orderHistoryPagination: "cursor" });
}

function createDefaultRnIapLoader(): IapPlatformLoader {
  return createRnPlatformLoader((framework) => {
    const iap = framework.IAP;
    if (typeof iap !== "object" || iap === null) {
      return { available: false, reason: "@apps-in-toss/framework does not expose an IAP domain" };
    }
    return { available: true, module: iap };
  });
}
