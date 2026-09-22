import { runEventFlow } from "../event-flow.js";
import type { SdkNotificationAgreementResult } from "../index.js";

/**
 * Internal platform contract for the notification-agreement adapter,
 * shared by /rn and /webview (never exported from a public subpath).
 */

export interface NotificationAgreementParams {
  options: { templateCode: string };
  onEvent: (result: { type: string }) => void | Promise<void>;
  onError: (error: unknown) => void | Promise<void>;
}

type FunctionWithSupport<F> = F & { isSupported?: () => boolean };

export interface NotificationLike {
  requestAgreement:
    | FunctionWithSupport<(params: NotificationAgreementParams) => () => void>
    | undefined;
}

export interface NotificationPlatformSdk {
  Notification?: NotificationLike;
}

export type NotificationPlatformLoader = () => Promise<
  { available: true; module: NotificationPlatformSdk } | { available: false; reason: string }
>;

type AgreementFlowEvent =
  | { kind: "agreement"; type: string; sourceEvent: Record<string, unknown> & { type: string } }
  | { kind: "sdkError"; error: unknown };

const TERMINAL_AGREEMENTS = new Set(["newAgreement", "alreadyAgreed", "agreementRejected"]);

/**
 * Runs one agreement request on the shared event-flow base: settle-once,
 * duplicate/late-event immunity, cleanup exactly once with exceptions
 * swallowed away from the result, registration-throw recovery, and one
 * overall deadline. The templateCode and the platform's raw event are
 * preserved verbatim in every outcome; the result describes only this
 * request, never a global notification setting or server consent state.
 */
export function runRequestAgreement(
  platform: NotificationPlatformSdk,
  templateCode: string,
  timeoutMs: number
): Promise<SdkNotificationAgreementResult> {
  return runEventFlow<AgreementFlowEvent, SdkNotificationAgreementResult>({
    timeoutMs,
    onTimeout: () => ({
      status: "timeout",
      templateCode,
      reason: `agreement request timed out after ${timeoutMs}ms; the user may still act — resolve the state server-side before retrying`
    }),
    register: (emit) =>
      platform.Notification!.requestAgreement!({
        options: { templateCode },
        onEvent: (result) => {
          // Preserve the platform's raw event object verbatim (including
          // any metadata beyond `type`) per the public contract.
          emit({
            kind: "agreement",
            type: result.type,
            sourceEvent: result as Record<string, unknown> & { type: string }
          });
        },
        onError: (error) => {
          emit({ kind: "sdkError", error });
        }
      }),
    reduce: (event) => {
      switch (event.kind) {
        case "agreement": {
          if (!TERMINAL_AGREEMENTS.has(event.type)) {
            return { done: false };
          }
          if (event.type === "agreementRejected") {
            return {
              done: true,
              result: { status: "rejected", templateCode, sourceEvent: event.sourceEvent }
            };
          }
          return {
            done: true,
            result: {
              status: "agreed",
              agreement: event.type as "newAgreement" | "alreadyAgreed",
              templateCode,
              sourceEvent: event.sourceEvent
            }
          };
        }
        case "sdkError": {
          const code = readErrorCode(event.error);
          return {
            done: true,
            result: {
              status: "failed",
              templateCode,
              ...(code !== undefined ? { code } : {}),
              reason: readErrorMessage(event.error)
            }
          };
        }
      }
    }
  });
}

export function readErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return undefined;
}

export function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return String(error);
}
