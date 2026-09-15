import { SdkError, type SdkShareUiResult } from "../index.js";
import { readErrorCode, readErrorMessage } from "../notification/platform-contract.js";

/**
 * Internal platform contract for the share adapter, shared by /rn and /web.
 */

export interface ShareCreateLinkParams {
  path: string;
  ogImageUrl?: string;
}

type FunctionWithSupport<F> = F & { isSupported?: () => boolean };

export interface ShareLike {
  createLink:
    | FunctionWithSupport<(params: ShareCreateLinkParams) => Promise<string>>
    | undefined;
  sendMessage:
    | FunctionWithSupport<(message: { message: string }) => Promise<void>>
    | undefined;
}

export interface SharePlatformSdk {
  Share?: ShareLike;
}

export type SharePlatformLoader = () => Promise<
  { available: true; module: SharePlatformSdk } | { available: false; reason: string }
>;

/**
 * Validates the documented input contract (an `intoss://` deeplink path)
 * before dispatching; the resolved share link passes through verbatim.
 */
export function validateSharePath(path: string): string {
  // The path is dispatched verbatim, so surrounding whitespace must be
  // rejected rather than silently trimmed away.
  if (typeof path !== "string" || !/^intoss:\/\/\S*$/.test(path)) {
    throw new SdkError(
      "INVALID_SHARE_PATH",
      `share link path must be an intoss:// deeplink, received: ${String(path)}`
    );
  }
  return path;
}

/**
 * Wraps the share-UI call: a resolution means the native share sheet flow
 * ended normally ("closed") — it never proves the user actually shared and
 * never grants reward eligibility. Rejections surface as failed with the
 * platform's error code/message preserved.
 */
export async function runShareUi(
  platform: SharePlatformSdk,
  message: string
): Promise<SdkShareUiResult> {
  try {
    await platform.Share!.sendMessage!({ message });
    return { status: "closed" };
  } catch (error) {
    const code = readErrorCode(error);
    return {
      status: "failed",
      ...(code !== undefined ? { code } : {}),
      reason: readErrorMessage(error)
    };
  }
}
