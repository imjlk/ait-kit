import { createIapAdapter, type IapAdapterOptions, type IapRecoveryResult } from "../iap/adapter.js";
import type { IapPlatformLoader, IapPlatformSdk } from "../iap/platform-contract.js";

/**
 * IAP adapter for React Native over the official `@apps-in-toss/framework`
 * (optional peer, imported lazily). The contract mirrors the web entry; the
 * two entries share the internal engine but never each other's SDK.
 */
export interface ReactNativeIapOptions extends Omit<IapAdapterOptions, "loader"> {
  /**
   * Framework injection: pass an `IAP` module instance or a custom loader
   * (tests/consumers). Defaults to the lazy
   * `import("@apps-in-toss/framework")` loader.
   */
  framework?: IapPlatformSdk | IapPlatformLoader;
}

export type ReactNativeIap = ReturnType<typeof createReactNativeIap>;
export type { IapRecoveryResult };

export function createReactNativeIap(options: ReactNativeIapOptions) {
  const loader: IapPlatformLoader = !options.framework
    ? createDefaultRnIapLoader()
    : typeof options.framework === "function"
      ? options.framework
      : async () => ({ available: true, module: options.framework as IapPlatformSdk });
  return createIapAdapter({ ...options, loader });
}

function createDefaultRnIapLoader(): IapPlatformLoader {
  let cached: IapPlatformSdk | undefined;
  return async () => {
    if (cached) {
      return { available: true, module: cached };
    }
    try {
      const framework = (await import("@apps-in-toss/framework")) as {
        IAP?: Partial<IapPlatformSdk>;
      };
      const iap = framework.IAP;
      if (
        !iap ||
        typeof iap.getProductItemList !== "function" ||
        typeof iap.createOneTimePurchaseOrder !== "function" ||
        typeof iap.createSubscriptionPurchaseOrder !== "function" ||
        typeof iap.getPendingOrders !== "function" ||
        typeof iap.completeProductGrant !== "function"
      ) {
        return {
          available: false,
          reason: "@apps-in-toss/framework does not expose the IAP APIs"
        };
      }
      cached = iap as IapPlatformSdk;
      return { available: true, module: cached };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, reason: `failed to import @apps-in-toss/framework: ${message}` };
    }
  };
}
