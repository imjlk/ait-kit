import { resolvePlatformLoader } from "../platform-loader.js";
import { createWebPlatformLoader } from "./platform-loader.js";
import {
  SdkError,
  type SdkNotificationAgreementResult,
  type SdkShareUiResult
} from "../index.js";
import {
  type NotificationPlatformLoader,
  type NotificationPlatformSdk,
  runRequestAgreement
} from "../notification/platform-contract.js";
import {
  type SharePlatformLoader,
  type SharePlatformSdk,
  runShareUi,
  validateSharePath
} from "../share/platform-contract.js";

const DEFAULT_AGREEMENT_TIMEOUT_MS = 60_000;

export interface WebNotificationOptions {
  /**
   * Web framework injection: pass a module exposing Notification or a
   * custom loader. Defaults to the lazy `import("@apps-in-toss/web-framework")`
   * loader.
   */
  framework?: NotificationPlatformSdk | NotificationPlatformLoader;
  /** Overall deadline per agreement request (default 60000ms; 0 disables). */
  timeoutMs?: number;
}

export interface WebNotification {
  /** See ReactNativeNotification.requestAgreement for the contract. */
  requestAgreement(templateCode: string): Promise<SdkNotificationAgreementResult>;
}

export function createWebNotification(options: WebNotificationOptions = {}): WebNotification {
  const loader = normalizeWebNotificationLoader(options.framework);
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGREEMENT_TIMEOUT_MS;
  return {
    requestAgreement(templateCode: string): Promise<SdkNotificationAgreementResult> {
      if (typeof templateCode !== "string" || !templateCode.trim()) {
        return Promise.reject(
          new SdkError("UNSUPPORTED", "templateCode must be a non-empty string")
        );
      }
      return agreementWithLoaderDeadline(loader, templateCode, timeoutMs);
    }
  };
}

export interface WebShareOptions {
  /**
   * Web framework injection: pass a module exposing Share or a custom
   * loader. Defaults to the lazy `import("@apps-in-toss/web-framework")`
   * loader.
   */
  framework?: SharePlatformSdk | SharePlatformLoader;
}

export interface WebShare {
  /** Creates a share link for an `intoss://` deeplink path. */
  createLink(path: string, ogImageUrl?: string): Promise<string>;
  /**
   * Opens the native share sheet; `completed` means only that the SDK share
   * call finished — it never proves the user shared and never grants reward
   * eligibility.
   */
  sendMessage(message: string): Promise<SdkShareUiResult>;
}

export function createWebShare(options: WebShareOptions = {}): WebShare {
  const loader = normalizeWebShareLoader(options.framework);
  const load = async (): Promise<SharePlatformSdk> => {
    const result = await loader();
    if (!result.available) {
      throw new SdkError("SDK_UNAVAILABLE", result.reason);
    }
    return result.module;
  };
  return {
    async createLink(path: string, ogImageUrl?: string) {
      const validated = validateSharePath(path);
      const platform = await load();
      const createLink = platform.Share?.createLink;
      if (typeof createLink !== "function") {
        throw new SdkError("UNSUPPORTED", "the installed SDK does not expose Share.createLink");
      }
      if (typeof createLink.isSupported === "function" && !createLink.isSupported()) {
        throw new SdkError("UNSUPPORTED", "share links are not supported on this app version");
      }
      return platform.Share!.createLink!(
        ogImageUrl !== undefined ? { path: validated, ogImageUrl } : { path: validated }
      );
    },

    async sendMessage(message: string) {
      if (typeof message !== "string" || !message) {
        throw new SdkError("UNSUPPORTED", "message must be a non-empty string");
      }
      const platform = await load();
      const sendMessage = platform.Share?.sendMessage;
      if (typeof sendMessage !== "function") {
        throw new SdkError("UNSUPPORTED", "the installed SDK does not expose Share.sendMessage");
      }
      if (typeof sendMessage.isSupported === "function" && !sendMessage.isSupported()) {
        throw new SdkError("UNSUPPORTED", "the share sheet is not supported on this app version");
      }
      return runShareUi(platform, message);
    }
  };
}

function normalizeWebNotificationLoader(
  framework: WebNotificationOptions["framework"]
): NotificationPlatformLoader {
  return resolvePlatformLoader(framework, createDefaultWebNotificationLoader);
}

function normalizeWebShareLoader(
  framework: WebShareOptions["framework"]
): SharePlatformLoader {
  return resolvePlatformLoader(framework, createDefaultWebShareLoader);
}

// See createDefaultWebIdentityLoader in ./identity.ts: the web SDK already
// matches the shared contract shapes, so no conversion or assertion is used.
function createDefaultWebNotificationLoader(): NotificationPlatformLoader {
  return createWebPlatformLoader(module => ({ available: true, module: module }));
}

function createDefaultWebShareLoader(): SharePlatformLoader {
  return createWebPlatformLoader(module => ({ available: true, module: module }));
}

/**
 * Same loader-covering deadline as the React Native adapter; see
 * agreementWithLoaderDeadline there for the contract.
 */
async function agreementWithLoaderDeadline(
  loader: NotificationPlatformLoader,
  templateCode: string,
  timeoutMs: number
): Promise<SdkNotificationAgreementResult> {
  const timedOut = (): SdkNotificationAgreementResult => ({
    status: "timeout",
    templateCode,
    reason: `agreement request timed out after ${timeoutMs}ms; the user may still act — resolve the state server-side before retrying`
  });
  if (!(timeoutMs > 0)) {
    return runRequestAgreement(await loadNotificationPlatform(loader), templateCode, 0);
  }
  const startedAt = Date.now();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loadDeadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      cancelled = true;
      resolve(null);
    }, timeoutMs);
  });
  let platform: NotificationPlatformSdk | null;
  try {
    platform = await Promise.race([
      loadNotificationPlatform(loader).then((loaded) => (cancelled ? null : loaded)),
      loadDeadline
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (!platform || cancelled || Date.now() - startedAt >= timeoutMs) {
    return timedOut();
  }
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  // The public reason reports the CONFIGURED deadline, not the remainder
  // left after loading; the remainder still bounds the actual flow.
  const flow = runRequestAgreement(platform, templateCode, remainingMs);
  const configured = timeoutMs;
  return flow.then((result) =>
    result.status === "timeout"
      ? {
          ...result,
          reason: `agreement request timed out after ${configured}ms; the user may still act — resolve the state server-side before retrying`
        }
      : result
  );
}

async function loadNotificationPlatform(
  loader: NotificationPlatformLoader
): Promise<NotificationPlatformSdk> {
  const result = await loader();
  if (!result.available) {
    throw new SdkError("SDK_UNAVAILABLE", result.reason);
  }
  const request = result.module.Notification?.requestAgreement;
  if (typeof request !== "function") {
    throw new SdkError(
      "UNSUPPORTED",
      "the installed SDK does not expose Notification.requestAgreement"
    );
  }
  if (typeof request.isSupported === "function" && !request.isSupported()) {
    throw new SdkError(
      "UNSUPPORTED",
      "notification agreements are not supported on this app version"
    );
  }
  return result.module;
}
