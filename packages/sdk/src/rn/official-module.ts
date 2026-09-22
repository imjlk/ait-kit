import { SdkError } from "../index.js";
import type { IdentityPlatformSdk } from "../identity/platform-contract.js";
import type {
  NotificationAgreementParams,
  NotificationPlatformSdk
} from "../notification/platform-contract.js";
import type { ShareCreateLinkParams, SharePlatformSdk } from "../share/platform-contract.js";

/**
 * Internal conversion layer between the official `@apps-in-toss/framework`
 * exports and the shared platform contracts. The official React Native SDK
 * (verified against 2.10.10, re-exported from @apps-in-toss/native-modules)
 * exposes these capabilities as flat module functions, while the shared
 * contracts (which match the web SDK's namespaced API) group them under
 * TossAuth/User/Notification/Share. This module performs that translation;
 * it is never exported from a public subpath.
 *
 * Every member of {@link OfficialRnFrameworkModule} is optional: older
 * app/SDK versions may omit any of them, and each adapter surfaces a
 * missing capability as a clear UNSUPPORTED error for that operation
 * instead of guessing a call shape.
 */

/** Official `appLogin()` result, preserved verbatim by the identity engine. */
export interface OfficialAppLoginResult {
  authorizationCode: string;
  referrer: "DEFAULT" | "SANDBOX";
}

/**
 * Official `getAnonymousKey()` success shape. The official function may
 * also resolve the `"ERROR"` sentinel (unknown failure) or `undefined`
 * (app below the feature's minimum version); both are handled by the
 * adapter below.
 */
export interface OfficialAnonymousKeyResult {
  type: "HASH";
  hash: string;
}

type OfficialFunction<F> = F & { isSupported?: () => boolean };

/** Structural subset of the official React Native framework module. */
export interface OfficialRnFrameworkModule {
  requestReview?: OfficialFunction<() => Promise<void>>;
  appLogin?: OfficialFunction<() => Promise<OfficialAppLoginResult>>;
  getAnonymousKey?: OfficialFunction<
    () => Promise<OfficialAnonymousKeyResult | "ERROR" | undefined>
  >;
  requestNotificationAgreement?: OfficialFunction<
    (params: NotificationAgreementParams) => () => void
  >;
  getTossShareLink?: OfficialFunction<(path: string, ogImageUrl?: string) => Promise<string>>;
  share?: OfficialFunction<(message: { message: string }) => Promise<void>>;
}

/**
 * Wraps an official function for the internal contract while preserving the
 * original receiver (the official module object, in case the implementation
 * relies on `this`) and an optional `isSupported` flag, so version-gate
 * checks keep working whenever the official SDK exposes them.
 */
function preserveSupport<W extends (...args: never[]) => unknown>(
  original: { isSupported?: () => boolean },
  wrapper: W
): W & { isSupported?: () => boolean } {
  if (typeof original.isSupported === "function") {
    return Object.assign(wrapper, { isSupported: () => original.isSupported!() });
  }
  return wrapper;
}

/**
 * Converts the official identity exports (`appLogin`, `getAnonymousKey`) to
 * the shared identity contract. Missing functions stay missing so the
 * shared engine reports UNSUPPORTED per operation.
 */
export function adaptOfficialRnIdentity(module: OfficialRnFrameworkModule): IdentityPlatformSdk {
  const identity: IdentityPlatformSdk = {};
  if (typeof module.appLogin === "function") {
    const appLogin = module.appLogin;
    identity.TossAuth = {
      login: preserveSupport(appLogin, () => appLogin.call(module))
    };
  }
  if (typeof module.getAnonymousKey === "function") {
    const getAnonymousKey = module.getAnonymousKey;
    identity.User = {
      getAnonymousKey: preserveSupport(getAnonymousKey, async () => {
        const result = await getAnonymousKey.call(module);
        // The official SDK resolves undefined when the installed app is
        // below the feature's minimum version: that is an unsupported
        // environment, not a malformed result.
        if (result === undefined) {
          throw new SdkError(
            "UNSUPPORTED",
            "the installed app version does not support getAnonymousKey"
          );
        }
        // The "ERROR" sentinel and malformed shapes are rejected by the
        // shared validator (runSdkGetAnonymousKey) like on any platform.
        return result;
      })
    };
  }
  return identity;
}

/**
 * Converts the official `requestNotificationAgreement` to the shared
 * notification contract. The official params shape matches the internal
 * one exactly, and the returned cleanup function passes through so the
 * event flow owns and invokes it.
 */
export function adaptOfficialRnNotification(module: OfficialRnFrameworkModule): NotificationPlatformSdk {
  const notification: NotificationPlatformSdk = {};
  if (typeof module.requestNotificationAgreement === "function") {
    const requestNotificationAgreement = module.requestNotificationAgreement;
    notification.Notification = {
      requestAgreement: preserveSupport(requestNotificationAgreement, (params: NotificationAgreementParams) =>
        requestNotificationAgreement.call(module, params)
      )
    };
  }
  return notification;
}

/**
 * Converts the official share exports to the shared share contract:
 * `getTossShareLink(path, ogImageUrl?)` takes positional arguments (the
 * internal contract's object form is unpacked here) and `share` receives
 * the `{ message }` object as-is.
 */
export function adaptOfficialRnShare(module: OfficialRnFrameworkModule): SharePlatformSdk {
  const share: SharePlatformSdk = {};
  if (typeof module.getTossShareLink === "function") {
    const getTossShareLink = module.getTossShareLink;
    share.Share = {
      createLink: preserveSupport(getTossShareLink, ({ path, ogImageUrl }: ShareCreateLinkParams) =>
        ogImageUrl !== undefined
          ? getTossShareLink.call(module, path, ogImageUrl)
          : getTossShareLink.call(module, path)
      )
    };
  }
  if (typeof module.share === "function") {
    const officialShare = module.share;
    share.Share = {
      ...share.Share,
      sendMessage: preserveSupport(officialShare, (message: { message: string }) =>
        officialShare.call(module, message)
      )
    };
  }
  return share;
}

/** Translate the official flat review function, preserving both receivers. */
export function adaptOfficialRnReview(module: OfficialRnFrameworkModule): import("../review/platform-contract.js").ReviewPlatformSdk {
  const request = module.requestReview;
  return typeof request === "function"
    ? { Review: { request: preserveSupport(request, () => request.call(module)) } }
    : {};
}
