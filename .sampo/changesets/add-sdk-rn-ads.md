---
npm/@ait-kit/sdk: minor
---

Add `@ait-kit/sdk` — a frontend SDK package with runtime-separated entry points.

- Root (`@ait-kit/sdk`): runtime-neutral shared contracts (`AdShowResult`, `AdReward`, `SdkError`) with no imports of any official SDK — plain Node consumers work without React Native packages.
- `@ait-kit/sdk/rn`: React Native full-screen ad adapter over the official `@apps-in-toss/framework` (an **optional peer**, imported lazily with no permanent failure caching). Rewards resolve only from the provider's `userEarnedReward` event; load/show success or dismissal never grants anything. Load state is tracked per ad type + unit with shared in-flight loads, retryable failures, single-use show consumption, per-flow deadlines, and explicit errors (`SDK_UNAVAILABLE`, `UNSUPPORTED`, `AD_NOT_LOADED`, `AD_ALREADY_SHOWING`).
- The shared event handling base (settle-once, late-event immunity, single error-swallowing cleanup, synchronous-callback-then-cleanup support, registration-throw recovery, deadline timers) is an internal module, ready for the IAP flow and a future `/web` entry.
- The SDK is versioned independently from the `@ait-kit/api-*` fixed release group. Server-side reward verification, session checks, and ledger handling remain consumer responsibilities.
