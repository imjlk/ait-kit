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

// ---------------------------------------------------------------------------
// Notification agreement
// ---------------------------------------------------------------------------

export interface ReactNativeNotificationOptions {
  /**
   * Framework injection: pass a module exposing Notification or a custom
   * loader. Defaults to the lazy `import("@apps-in-toss/framework")` loader.
   */
  framework?: NotificationPlatformSdk | NotificationPlatformLoader;
  /** Overall deadline per agreement request (default 60000ms; 0 disables). */
  timeoutMs?: number;
}

export interface ReactNativeNotification {
  /**
   * Requests agreement for one template. The result preserves the
   * templateCode and the platform's raw event, and describes only this
   * request — syncing consent state to a server is the consumer's job.
   */
  requestAgreement(templateCode: string): Promise<SdkNotificationAgreementResult>;
}

export function createReactNativeNotification(
  options: ReactNativeNotificationOptions = {}
): ReactNativeNotification {
  const loader = normalizeNotificationLoader(options.framework);
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

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export interface ReactNativeShareOptions {
  /**
   * Framework injection: pass a module exposing Share or a custom loader.
   * Defaults to the lazy `import("@apps-in-toss/framework")` loader.
   */
  framework?: SharePlatformSdk | SharePlatformLoader;
}

export interface ReactNativeShare {
  /** Creates a share link for an `intoss://` deeplink path. */
  createLink(path: string, ogImageUrl?: string): Promise<string>;
  /**
   * Opens the native share sheet. Resolving `closed` means the sheet flow
   * ended — it does not prove the user shared and never grants reward
   * eligibility.
   */
  sendMessage(message: string): Promise<SdkShareUiResult>;
}

export function createReactNativeShare(
  options: ReactNativeShareOptions = {}
): ReactNativeShare {
  const loader = normalizeShareLoader(options.framework);
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
      // Receiver-preserving member call; optional OG image only when present.
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

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export function normalizeNotificationLoader(
  framework: ReactNativeNotificationOptions["framework"]
): NotificationPlatformLoader {
  if (!framework) {
    return createDefaultRnModuleLoader<NotificationPlatformSdk>();
  }
  if (typeof framework === "function") {
    return framework;
  }
  return async () => ({ available: true, module: framework });
}

export function normalizeShareLoader(
  framework: ReactNativeShareOptions["framework"]
): SharePlatformLoader {
  if (!framework) {
    return createDefaultRnModuleLoader<SharePlatformSdk>();
  }
  if (typeof framework === "function") {
    return framework;
  }
  return async () => ({ available: true, module: framework });
}

function createDefaultRnModuleLoader<T>(): () => Promise<
  { available: true; module: T } | { available: false; reason: string }
> {
  let cached: T | undefined;
  return async () => {
    if (cached) {
      return { available: true, module: cached };
    }
    try {
      const framework = (await import("@apps-in-toss/framework")) as T;
      cached = framework;
      return { available: true, module: cached };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        reason: `failed to import @apps-in-toss/framework: ${message}`
      };
    }
  };
}

/**
 * Runs one agreement under a deadline that also covers platform loading:
 * a stalled loader cannot wedge the request, a loader resolving after the
 * deadline never registers, and the flow owns the remaining budget.
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
