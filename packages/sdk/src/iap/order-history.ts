import { SdkError, type IapOrderHistoryPage, type IapCompletedOrRefundedOrder } from "../index.js";
import { toIapErrorCode, type PartialIapPlatformSdk } from "./platform-contract.js";

export async function queryOrderHistory(
  load: () => Promise<PartialIapPlatformSdk>,
  pagination: IapOrderHistoryPage["pagination"],
  params?: { key?: string | null }
): Promise<IapOrderHistoryPage> {
  if (params !== undefined && (!isRecord(params) ||
      (params.key !== undefined && params.key !== null && (typeof params.key !== "string" || !params.key.trim())))) {
    throw new SdkError("INVALID_IAP_INPUT", "history key must be a non-empty string or null");
  }
  const key = params?.key;
  if (pagination === "first_page_only" && key != null) {
    throw new SdkError("UNSUPPORTED", "the WebView SDK only supports the first order history page");
  }
  const platform = await load();
  const query = platform.getCompletedOrRefundedOrders;
  if (typeof query !== "function" || (typeof query.isSupported === "function" && !query.isSupported())) {
    throw new SdkError("UNSUPPORTED", "order history is not supported on this app version");
  }
  let result: unknown;
  try {
    // WebView's official function takes no arguments; never send a fabricated cursor.
    result = pagination === "cursor" && key !== undefined
      ? await query.call(platform, { key })
      : await query.call(platform);
  } catch (error) {
    if (toIapErrorCode(error) === "UNSUPPORTED_APP_VERSION") {
      throw new SdkError("UNSUPPORTED", "order history is not supported on this app version", { cause: error });
    }
    throw error;
  }
  if (result === undefined) throw new SdkError("UNSUPPORTED", "order history is not supported on this app version");
  if (!isRecord(result) || typeof result.hasNext !== "boolean" || !Array.isArray(result.orders) ||
      (result.nextKey !== undefined && result.nextKey !== null && typeof result.nextKey !== "string") ||
      !result.orders.every(isOrder)) {
    throw new SdkError("INVALID_IAP_RESULT", "the provider returned malformed order history");
  }
  return {
    orders: result.orders.map(order => ({ orderId: order.orderId, sku: order.sku, status: order.status, date: order.date })),
    hasNext: result.hasNext,
    ...(result.nextKey !== undefined ? { nextKey: result.nextKey } : {}),
    pagination
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function isOrder(value: unknown): value is IapCompletedOrRefundedOrder {
  return isRecord(value) && typeof value.orderId === "string" && !!value.orderId.trim() &&
    typeof value.sku === "string" && !!value.sku.trim() && typeof value.date === "string" &&
    (value.status === "COMPLETED" || value.status === "REFUNDED");
}
