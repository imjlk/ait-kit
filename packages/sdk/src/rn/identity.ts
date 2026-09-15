import { SdkError, type SdkAnonymousKey, type SdkLoginResult } from "../index.js";
import {
  type IdentityPlatformLoader,
  type IdentityPlatformSdk,
  runSdkGetAnonymousKey,
  runSdkLogin
} from "../identity/platform-contract.js";
import { adaptOfficialRnIdentity } from "./official-module.js";

export interface ReactNativeIdentityOptions {
  /**
   * Framework injection: pass a module exposing TossAuth/User or a custom
   * loader (tests, dev replacements). Defaults to the lazy
   * `import("@apps-in-toss/framework")` loader. The default never guesses
   * the environment or substitutes a fake login.
   */
  framework?: IdentityPlatformSdk | IdentityPlatformLoader;
}

export interface ReactNativeIdentity {
  /** Starts the platform login and validates/preserves the result. */
  login(): Promise<SdkLoginResult>;
  /** Looks up the SDK-issued anonymous key; never fabricates one. */
  getAnonymousKey(): Promise<SdkAnonymousKey>;
}

export function createReactNativeIdentity(options: ReactNativeIdentityOptions = {}): ReactNativeIdentity {
  const loader = normalizeIdentityLoader(options.framework);
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

export function normalizeIdentityLoader(
  framework: ReactNativeIdentityOptions["framework"]
): IdentityPlatformLoader {
  if (!framework) {
    return createDefaultRnIdentityLoader();
  }
  if (typeof framework === "function") {
    return framework;
  }
  return async () => ({ available: true, module: framework });
}

/**
 * Default loader: imports the official `@apps-in-toss/framework` lazily and
 * converts its flat export surface (`appLogin`, `getAnonymousKey`) to the
 * shared identity contract. A failed import is never cached (a later call
 * retries); successful loads cache the converted module.
 */
function createDefaultRnIdentityLoader(): IdentityPlatformLoader {
  let cached: IdentityPlatformSdk | undefined;
  return async () => {
    if (cached) {
      return { available: true, module: cached };
    }
    try {
      cached = adaptOfficialRnIdentity(await import("@apps-in-toss/framework"));
      return { available: true, module: cached };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { available: false, reason: `failed to import @apps-in-toss/framework: ${message}` };
    }
  };
}
