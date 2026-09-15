---
npm/@ait-kit/sdk: minor
---

Add the `@ait-kit/sdk/web` entrypoint and reliable IAP adapters for both platforms.

- **New `/web` entry**: lazily imports the official `@apps-in-toss/web-framework` (optional peer, failures never cached). `/rn` and `/web` keep completely separate SDK connections — in JavaScript and in the shipped declarations — so neither entry's consumers need the other platform's package; the root stays importable in plain Node without any platform SDK.
- **IAP adapters (`createReactNativeIap` / `createWebIap`)**: product listing, one-time and subscription purchases, pending-order lookup, and grant-completion notification per the official Domains API, with per-function `UNSUPPORTED` gating.
- **Server grant callback injection**: product delivery happens only through the consumer-injected `grant` callback, whose contract is to resolve only after the consumer's server verified the order and persisted the grant. The adapter contains no backend URLs, auth, or persistence.
- **Duplicate control (client-side, per-adapter scope)**: concurrent grants for one order share the in-flight call only for identical targets (orderId + sku; recovery callers without a subscriptionId join cached subscription grants, explicitly conflicting duplicates reject); successful grants are reused in scope; failures are not cached and retry for real. Documented as a client-side reduction only — server-side idempotency remains mandatory.
- **Order linking**: `completed` requires the success event's order and the grant-confirmed order to match; a mismatch ends as `failed`/`ORDER_MISMATCH`, a success event before the grant settles is parked until confirmation, and a failed grant ends as `grant_failed` — never as purchase success. Timeouts report `unknown` (the grant may still be running) and late events never rewrite a settled result.
- **Pending-order recovery (explicit, never automatic)**: `recoverPendingOrder` runs the server grant first and sends `completeProductGrant` only after it confirms.
