import { resolvePlatformLoader } from "../platform-loader.js";
import { createRnPlatformLoader } from "./platform-loader.js";
import { SdkError, type SdkAnonymousKey, type SdkAnonymousKeyLookupOptions, type SdkLoginResult } from "../index.js";
import {
  type IdentityPlatformLoader,
  type IdentityPlatformSdk,
  createSharedAnonymousKeyLookup,
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
  /**
   * Looks up the SDK-issued anonymous key; never fabricates one. Concurrent
   * lookups share one in-flight SDK call (never cached once settled);
   * `timeoutMs` opts into a per-caller deadline that rejects with
   * SdkError("TIMEOUT") without cancelling the shared call.
   */
  getAnonymousKey(options?: SdkAnonymousKeyLookupOptions): Promise<SdkAnonymousKey>;
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
    getAnonymousKey: createSharedAnonymousKeyLookup(load)
  };
}

export function normalizeIdentityLoader(
  framework: ReactNativeIdentityOptions["framework"]
): IdentityPlatformLoader {
  return resolvePlatformLoader(framework, createDefaultRnIdentityLoader);
}

/**
 * Default loader: imports the official `@apps-in-toss/framework` lazily and
 * converts its flat export surface (`appLogin`, `getAnonymousKey`) to the
 * shared identity contract. A failed import is never cached (a later call
 * retries); successful loads cache the converted module.
 */
function createDefaultRnIdentityLoader(): IdentityPlatformLoader {
  return createRnPlatformLoader(module => ({ available: true, module: adaptOfficialRnIdentity(module) }));
}
