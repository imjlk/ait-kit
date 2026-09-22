import { SdkError } from "../index.js";
import type {
  PromotionAdapter, PromotionGrantInput, PromotionGrantResult,
  PromotionPlatformLoader, PromotionPlatformSdk, PromotionSupport
} from "./platform-contract.js";

// Official Promotion.grantReward documentation (RN 2.10.10 / Web 3.4.0).
// 4113 is intentionally absent: it cannot establish this attempt's outcome.
const REJECTION_CODES = new Set(["4100", "4104", "4105", "4108", "4109", "4110", "4112", "4114"]);

function unknown(reason: Extract<PromotionGrantResult, { status: "unknown" }>["reason"], providerCode?: string): PromotionGrantResult {
  return providerCode === undefined ? { status: "unknown", reason } : { status: "unknown", reason, providerCode };
}

function normalize(value: unknown, thrown: boolean): PromotionGrantResult {
  if (typeof value !== "object" || value === null) {
    return unknown(thrown || value === "ERROR" ? "sdk_error" : "invalid_response");
  }
  const data = value as Record<string, unknown>;
  const rawCode = data.errorCode ?? data.code;
  const code = typeof rawCode === "string" && /^[A-Z0-9_]{1,64}$/.test(rawCode) ? rawCode : undefined;
  const hasError = "errorCode" in data || "code" in data || "error" in data || "message" in data;
  if (("key" in data && (thrown || hasError)) ||
      (data.code !== undefined && data.errorCode !== undefined && data.code !== data.errorCode)) {
    return unknown("invalid_response", code);
  }
  if (!thrown && typeof data.key === "string" && data.key.trim().length > 0) {
    return { status: "granted", rewardKey: data.key };
  }
  if ("key" in data) return unknown("invalid_response", code);
  if (code === "UNSUPPORTED_APP_VERSION") {
    throw new SdkError("UNSUPPORTED", "direct promotion rewards are not supported on this app version");
  }
  if (code && REJECTION_CODES.has(code)) return { status: "rejected", providerCode: code };
  return unknown(code ? "ambiguous_provider_error" : thrown ? "sdk_error" : "invalid_response", code);
}

function support(platform: PromotionPlatformSdk): PromotionSupport {
  const grant = platform.Promotion?.grantReward;
  if (typeof grant !== "function") return "unsupported";
  if (typeof grant.isSupported !== "function") return "unknown";
  return grant.isSupported() ? "supported" : "unsupported";
}

function validate(input: PromotionGrantInput): PromotionGrantInput {
  if (!input || typeof input.promotionCode !== "string" || !input.promotionCode.trim() ||
      input.promotionCode !== input.promotionCode.trim() || !Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new SdkError("INVALID_PROMOTION_INPUT", "promotionCode must be non-empty without surrounding whitespace and amount must be a positive safe integer");
  }
  // Snapshot before loading; callers cannot change the pending payment input.
  return { promotionCode: input.promotionCode, amount: input.amount };
}

export function createPromotionAdapter(loader: PromotionPlatformLoader, timeoutMs = 0): PromotionAdapter {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new SdkError("INVALID_PROMOTION_INPUT", "timeoutMs must be an integer from 0 to 2147483647");
  }
  let inFlight = false;
  const load = async () => {
    const result = await loader();
    if (!result.available) throw new SdkError("SDK_UNAVAILABLE", result.reason);
    return result.module;
  };
  return {
    async getSupport() { return support(await load()); },
    grantReward(input) {
      let validated: PromotionGrantInput;
      try { validated = validate(input); } catch (error) { return Promise.reject(error); }
      if (inFlight) return Promise.reject(new SdkError("PROMOTION_IN_PROGRESS", "a direct promotion request is still in progress"));
      inFlight = true;
      let expired = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = Promise.resolve().then(async (): Promise<PromotionGrantResult> => {
        const platform = await load();
        // A loading timeout must not launch a new payment later.
        if (expired) return unknown("timeout");
        if (support(platform) === "unsupported") {
          throw new SdkError("UNSUPPORTED", "the installed SDK or app does not support direct promotion rewards");
        }
        let response: unknown;
        try {
          response = await platform.Promotion!.grantReward!(validated);
        } catch (error) {
          // The RN conversion uses this only for the documented undefined result.
          if (error instanceof SdkError && error.code === "UNSUPPORTED") throw error;
          return normalize(error, true);
        }
        return normalize(response, false);
      }).finally(() => {
        inFlight = false;
        if (timer !== undefined) clearTimeout(timer);
      });
      if (timeoutMs === 0) return work;
      const deadline = new Promise<PromotionGrantResult>(resolve => {
        timer = setTimeout(() => { expired = true; resolve(unknown("timeout")); }, timeoutMs);
      });
      // Only actual SDK/load settlement releases the lock, not this race.
      return Promise.race([work, deadline]);
    }
  };
}
