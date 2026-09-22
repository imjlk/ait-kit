import { SdkError, type IapSubscriptionInfo } from "../index.js";
import { toIapErrorCode, type PartialIapPlatformSdk } from "./platform-contract.js";

export async function querySubscriptionInfo(platform: PartialIapPlatformSdk, orderId: string): Promise<{ subscription: IapSubscriptionInfo }> {
  let result: unknown;
  try {
    result = await platform.getSubscriptionInfo!({ params: { orderId } });
  } catch (error) {
    if (toIapErrorCode(error) === "UNSUPPORTED_APP_VERSION") {
      throw new SdkError("UNSUPPORTED", "subscription queries are not supported on this app version", { cause: error });
    }
    throw error;
  }
  // The RN SDK returns undefined on unsupported host versions.
  if (result === undefined) throw new SdkError("UNSUPPORTED", "subscription queries are not supported on this app version");
  const info = isRecord(result) ? result.subscription : undefined;
  if (!isRecord(info) || typeof info.catalogId !== "number" || !Number.isFinite(info.catalogId) ||
      typeof info.status !== "string" || !info.status.trim() ||
      !nullableString(info.expiresAt) || !nullableString(info.gracePeriodExpiresAt) ||
      typeof info.isAutoRenew !== "boolean" || typeof info.isAccessible !== "boolean") {
    throw new SdkError("INVALID_IAP_RESULT", "the provider returned malformed subscription information");
  }
  return { subscription: {
    catalogId: info.catalogId,
    status: info.status,
    expiresAt: info.expiresAt,
    isAutoRenew: info.isAutoRenew,
    gracePeriodExpiresAt: info.gracePeriodExpiresAt,
    isAccessible: info.isAccessible
  } };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
