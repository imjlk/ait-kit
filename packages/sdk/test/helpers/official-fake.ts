import type { OfficialRnFrameworkModule } from "../../src/rn/official-module.js";

/**
 * Fake shaped like the official flat RN exports (verified against
 * @apps-in-toss/framework 2.10.10). Implementations read `this`, so tests
 * can assert call-context preservation, and every call is recorded
 * (arguments plus the receiver marker).
 */
type OfficialModuleOverrides = {
  [K in keyof OfficialRnFrameworkModule]?: NonNullable<OfficialRnFrameworkModule[K]>;
};

export function officialModule(
  overrides: OfficialModuleOverrides = {}
): OfficialRnFrameworkModule & {
  marker: string;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, value: unknown) => {
    calls[name] = calls[name] ?? [];
    (calls[name] as unknown[]).push(value);
  };
  return {
    grantPromotionReward: overrides.grantPromotionReward ?? function(this: unknown, params) {
      record("grantPromotionReward", { params, receiver: (this as { marker?: string })?.marker });
      return Promise.resolve({ key: "synthetic-reward" });
    },
    requestReview: Object.assign(overrides.requestReview ?? function(this: unknown) {
      record("requestReview", (this as { marker?: string })?.marker);
      return Promise.resolve();
    }, { isSupported: () => true }),
    marker: "official-module",
    calls,
    appLogin: Object.assign(
      overrides.appLogin ??
        (function (this: unknown) {
          record("appLogin", (this as { marker?: string })?.marker ?? "missing-receiver");
          return Promise.resolve({ authorizationCode: "code-1", referrer: "SANDBOX" as const });
        }),
      { isSupported: () => true }
    ),
    getAnonymousKey: Object.assign(
      overrides.getAnonymousKey ??
        (function (this: unknown) {
          record("getAnonymousKey", (this as { marker?: string })?.marker ?? "missing-receiver");
          return Promise.resolve({ type: "HASH" as const, hash: "hash-1" });
        }),
      { isSupported: () => true }
    ),
    requestNotificationAgreement: Object.assign(
      overrides.requestNotificationAgreement ??
        (function (this: unknown, params: unknown) {
          record("requestNotificationAgreement", {
            params,
            receiver: (this as { marker?: string })?.marker
          });
          return () => {
            record("cleanup", true);
          };
        }),
      { isSupported: () => true }
    ),
    getTossShareLink: Object.assign(
      overrides.getTossShareLink ??
        (function (this: unknown, ...args: unknown[]) {
          record("getTossShareLink", [...args, (this as { marker?: string })?.marker]);
          return Promise.resolve(`https://toss.im/share/${String(args[0])}`);
        }),
      { isSupported: () => true }
    ),
    share: Object.assign(
      overrides.share ??
        (function (this: unknown, message: unknown) {
          record("share", [message, (this as { marker?: string })?.marker]);
          return Promise.resolve();
        }),
      { isSupported: () => true }
    )
  };
}
