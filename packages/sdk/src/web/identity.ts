import { SdkError, type SdkAnonymousKey, type SdkLoginResult, type SdkStorage } from "../index.js";
import {
  type IdentityPlatformLoader,
  type IdentityPlatformSdk,
  runSdkGetAnonymousKey,
  runSdkLogin
} from "../identity/platform-contract.js";
import {
  createSdkStorageFromPlatform,
  type StoragePlatformLoader,
  type StoragePlatformSdk
} from "../storage/platform-contract.js";

export interface WebIdentityOptions {
  /**
   * Web framework injection: pass a module exposing TossAuth/User or a
   * custom loader (tests, dev replacements). Defaults to the lazy
   * `import("@apps-in-toss/web-framework")` loader. The default never
   * guesses the environment or substitutes a fake login.
   */
  framework?: IdentityPlatformSdk | IdentityPlatformLoader;
}

export interface WebIdentity {
  /** Starts the platform login and validates/preserves the result. */
  login(): Promise<SdkLoginResult>;
  /** Looks up the SDK-issued anonymous key; never fabricates one. */
  getAnonymousKey(): Promise<SdkAnonymousKey>;
}

export function createWebIdentity(options: WebIdentityOptions = {}): WebIdentity {
  const loader = normalizeWebIdentityLoader(options.framework);
  const load = async (): Promise<IdentityPlatformSdk> => {
    const result = await loader();
    if (!result.available) {
      throw new SdkError("SDK_UNAVAILABLE", result.reason);
    }
    return result.module;
  };
  return {
    login: async () => runSdkLogin(await load()),
    getAnonymousKey: async () => runSdkGetAnonymousKey(await load())
  };
}

export interface WebStorageOptions {
  /**
   * Web framework injection: pass a module exposing Storage or a custom
   * loader. Defaults to the lazy `import("@apps-in-toss/web-framework")`
   * loader.
   */
  framework?: StoragePlatformSdk | StoragePlatformLoader;
}

/** SDK-backed storage for web with the same verbatim-key contract as /rn. */
export function createWebStorage(options: WebStorageOptions = {}): SdkStorage {
  const loader = normalizeWebStorageLoader(options.framework);
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

function normalizeWebIdentityLoader(
  framework: WebIdentityOptions["framework"]
): IdentityPlatformLoader {
  if (!framework) {
    return createDefaultWebLoader<IdentityPlatformSdk>();
  }
  if (typeof framework === "function") {
    return framework;
  }
  return async () => ({ available: true, module: framework });
}

function normalizeWebStorageLoader(
  framework: WebStorageOptions["framework"]
): StoragePlatformLoader {
  if (!framework) {
    return createDefaultWebLoader<StoragePlatformSdk>();
  }
  if (typeof framework === "function") {
    return framework;
  }
  return async () => ({ available: true, module: framework });
}

function createDefaultWebLoader<T>(): () => Promise<
  { available: true; module: T } | { available: false; reason: string }
> {
  let cached: T | undefined;
  return async () => {
    if (cached) {
      return { available: true, module: cached };
    }
    try {
      const framework = (await import("@apps-in-toss/web-framework")) as T;
      cached = framework;
      return { available: true, module: cached };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        reason: `failed to import @apps-in-toss/web-framework: ${message}`
      };
    }
  };
}
