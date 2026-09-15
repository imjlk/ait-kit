import { SdkError, type SdkStorage } from "../index.js";
import {
  createSdkStorageFromPlatform,
  type StoragePlatformLoader,
  type StoragePlatformSdk
} from "../storage/platform-contract.js";

export interface ReactNativeStorageOptions {
  /**
   * Framework injection: pass a module exposing Storage or a custom loader
   * (tests, dev replacements). Defaults to the lazy
   * `import("@apps-in-toss/framework")` loader.
   */
  framework?: StoragePlatformSdk | StoragePlatformLoader;
}

/**
 * SDK-backed storage for React Native. Keys and string values pass through
 * verbatim (no namespace prefixing); get resolves null for missing keys and
 * set/remove rejections propagate so failures stay observable.
 */
export function createReactNativeStorage(
  options: ReactNativeStorageOptions = {}
): SdkStorage {
  const loader = normalizeStorageLoader(options.framework);
  let cached: SdkStorage | undefined;
  let resolving: Promise<SdkStorage> | undefined;
  const resolve = (): Promise<SdkStorage> => {
    if (cached) {
      return Promise.resolve(cached);
    }
    // Concurrent initial calls share one loader invocation so custom
    // loaders cannot hand out independent stores.
    if (!resolving) {
      resolving = (async () => {
        const result = await loader();
        if (!result.available) {
          throw new SdkError("SDK_UNAVAILABLE", result.reason);
        }
        cached = createSdkStorageFromPlatform(result.module);
        return cached;
      })();
      resolving.catch(() => {
        resolving = undefined;
      });
    }
    return resolving;
  };
  return {
    get: async (key) => (await resolve()).get(key),
    set: async (key, value) => (await resolve()).set(key, value),
    remove: async (key) => (await resolve()).remove(key)
  };
}

export function normalizeStorageLoader(
  framework: ReactNativeStorageOptions["framework"]
): StoragePlatformLoader {
  if (!framework) {
    return createDefaultRnStorageLoader();
  }
  if (typeof framework === "function") {
    return framework;
  }
  return async () => ({ available: true, module: framework });
}

function createDefaultRnStorageLoader(): StoragePlatformLoader {
  let cached: StoragePlatformSdk | undefined;
  return async () => {
    if (cached) {
      return { available: true, module: cached };
    }
    try {
      const framework = (await import("@apps-in-toss/framework")) as StoragePlatformSdk;
      cached = framework;
      return { available: true, module: cached };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, reason: `failed to import @apps-in-toss/framework: ${message}` };
    }
  };
}
