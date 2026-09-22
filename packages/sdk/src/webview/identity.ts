import { resolvePlatformLoader } from "../platform-loader.js";
import { createWebViewPlatformLoader } from "./platform-loader.js";
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

export interface WebViewIdentityOptions {
  /**
   * WebView framework injection: pass a module exposing TossAuth/User or a
   * custom loader (tests, dev replacements). Defaults to the lazy
   * `import("@apps-in-toss/web-framework")` loader. The default never
   * guesses the environment or substitutes a fake login.
   */
  framework?: IdentityPlatformSdk | IdentityPlatformLoader;
}

export interface WebViewIdentity {
  /** Starts the platform login and validates/preserves the result. */
  login(): Promise<SdkLoginResult>;
  /** Looks up the SDK-issued anonymous key; never fabricates one. */
  getAnonymousKey(): Promise<SdkAnonymousKey>;
}

export function createWebViewIdentity(options: WebViewIdentityOptions = {}): WebViewIdentity {
  const loader = normalizeWebViewIdentityLoader(options.framework);
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

export interface WebViewStorageOptions {
  /**
   * WebView framework injection: pass a module exposing Storage or a custom
   * loader. Defaults to the lazy `import("@apps-in-toss/web-framework")`
   * loader.
   */
  framework?: StoragePlatformSdk | StoragePlatformLoader;
}

/** SDK-backed storage for web with the same verbatim-key contract as /rn. */
export function createWebViewStorage(options: WebViewStorageOptions = {}): SdkStorage {
  const loader = normalizeWebViewStorageLoader(options.framework);
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

function normalizeWebViewIdentityLoader(
  framework: WebViewIdentityOptions["framework"]
): IdentityPlatformLoader {
  return resolvePlatformLoader(framework, createDefaultWebViewIdentityLoader);
}

function normalizeWebViewStorageLoader(
  framework: WebViewStorageOptions["framework"]
): StoragePlatformLoader {
  return resolvePlatformLoader(framework, createDefaultWebViewStorageLoader);
}

// The web SDK exposes the shared namespaced contract shapes directly, so
// the default loaders consume the official module without any conversion
// or type assertion; a failed import is never cached, successful loads are.
function createDefaultWebViewIdentityLoader(): IdentityPlatformLoader {
  return createWebViewPlatformLoader(module => ({ available: true, module: module }));
}

function createDefaultWebViewStorageLoader(): StoragePlatformLoader {
  return createWebViewPlatformLoader(module => ({ available: true, module: module }));
}

/** @deprecated Use createWebViewIdentity from @ait-kit/sdk/webview. */
export const createWebIdentity = createWebViewIdentity;
/** @deprecated Use createWebViewStorage from @ait-kit/sdk/webview. */
export const createWebStorage = createWebViewStorage;
/** @deprecated Use WebViewIdentity from @ait-kit/sdk/webview. */
export type WebIdentity = WebViewIdentity;
/** @deprecated Use WebViewIdentityOptions from @ait-kit/sdk/webview. */
export type WebIdentityOptions = WebViewIdentityOptions;
/** @deprecated Use WebViewStorageOptions from @ait-kit/sdk/webview. */
export type WebStorageOptions = WebViewStorageOptions;
