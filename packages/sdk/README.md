# @ait-kit/sdk

Frontend SDK adapters for Apps in Toss mini apps: shared contracts plus
per-runtime entry points.

```bash
npm install @ait-kit/sdk
```

## Entry points

| Entry | Use it for |
|---|---|
| `@ait-kit/sdk` (root) | Runtime-neutral shared contracts: `AdShowResult`, `AdReward`, `SdkError`. Importable anywhere — plain Node, web, React Native — with no official SDK installed. |
| `@ait-kit/sdk/rn` | React Native adapters (full-screen ads today; more domains later). Requires the official `@apps-in-toss/framework`, declared as an **optional peer** and imported lazily. |

A `@ait-kit/sdk/web` entry is planned; runtime adapters always live in their
own subpath so the root stays dependency-free.

## React Native full-screen ads

```ts
import { createReactNativeAds } from "@ait-kit/sdk/rn";

const ads = createReactNativeAds();
await ads.loadFullScreenAd("AD_GROUP_ID"); // joins an in-flight duplicate load
const result = await ads.showFullScreenAd("AD_GROUP_ID");

if (result.status === "rewarded") {
  // result.reward came from the provider's userEarnedReward event — nothing
  // else (load success, show success, dismissal) ever grants a reward.
  // Verify against YOUR server before crediting anything.
}
```

Behavior:

- Load state is tracked per ad type + ad unit. Concurrent duplicate loads
  share one registration; failed loads clear the slot so the next attempt
  retries instead of being blocked.
- Showing requires a completed load (`AD_NOT_LOADED` otherwise). The same ad
  group cannot be shown concurrently (`AD_ALREADY_SHOWING`). Full-screen ads
  are single-use: after a show flow ends (rewarded, dismissed, failed,
  timeout), a fresh load is required.
- The whole show flow has one deadline (`showTimeoutMs`, default 60s);
  `loadTimeoutMs` (default 30s) bounds loads.
- Missing or failed-to-import framework → `SdkError("SDK_UNAVAILABLE")`;
  unsupported app versions → `SdkError("UNSUPPORTED")`. Load failures are
  never permanently cached — a later call retries the import.
- By default the adapter never fabricates ad success or reward results:
  outcomes come only from the provider's events.

## Responsibility split

The SDK provides ad behavior and outcomes. Your application owns server-side
ad reward requests, user session checks, payout limits, and ledger updates.
(Login/anonymous-key helpers and storage arrive in later entries, as do
notification and sharing.)

## Versioning

`@ait-kit/sdk` is versioned independently from the server API packages
(`@ait-kit/api-*`), which release in lockstep with each other.
