# @ait-kit/sdk

Frontend SDK adapters for Apps in Toss mini apps: shared contracts plus
per-runtime entry points.

```bash
npm install @ait-kit/sdk
```

## Entry points

| Entry | Use it for |
|---|---|
| `@ait-kit/sdk` (root) | Runtime-neutral shared contracts: ad + IAP types, `SdkError`. Importable anywhere — plain Node, web, React Native — with no official SDK installed. |
| `@ait-kit/sdk/rn` | React Native adapters (full-screen ads, IAP). Requires the official `@apps-in-toss/framework`, declared as an **optional peer** and imported lazily. Never requires the web SDK. |
| `@ait-kit/sdk/web` | Web adapters (IAP). Requires the official `@apps-in-toss/web-framework`, declared as an **optional peer** and imported lazily. Never requires the React Native SDK. |

The two platform entries share one internal engine but keep completely
separate SDK connections — in JavaScript and in the shipped type
declarations — so an `/rn` consumer never installs the web package and vice
versa.

## In-app purchases (RN + Web)

Both entries expose the same IAP surface; only the loader differs:

```ts
import { createReactNativeIap } from "@ait-kit/sdk/rn";   // or:
import { createWebIap } from "@ait-kit/sdk/web";

const iap = createReactNativeIap({
  // The ONLY place product delivery happens. Resolve only after YOUR
  // server verified the order with the provider and persisted the grant
  // (see @ait-kit/api-core's iapOrderStatus for server-side verification).
  grant: async ({ orderId, sku }) => {
    const response = await fetch("/api/iap/grant", {
      method: "POST",
      body: JSON.stringify({ orderId, sku })
    });
    if (!response.ok) {
      // Resolve-only-on-success is part of the contract: never report a
      // grant your server did not verify and persist.
      throw new Error(`grant request failed: HTTP ${response.status}`);
    }
  }
});

// 1. Start a purchase.
const result = await iap.purchaseOneTime("SKU_100_COINS");
//    result.status: "completed" | "canceled" | "failed"
//                | "grant_failed" | "unknown"

// 2. Subscriptions work the same way.
await iap.purchaseSubscription("SKU_PREMIUM", offerId);
```

`completed` requires **both** the platform's success event and your grant
callback having resolved for the **same order**: a success event alone never
completes a purchase, a grant for a different order ends as
`failed`/`ORDER_MISMATCH`, and a failed server grant ends as `grant_failed`
— never as purchase success. `unknown` (e.g. timeout) means the grant may
still be in progress; the client timeout does not cancel it.

### Duplicate grant control (client-side, scoped to one adapter)

- Concurrent grants for the same order share one in-flight call — only for
  identical targets (same `orderId` and `sku`; callers that do not know the
  `subscriptionId`, like pending-order recovery, may join a cached
  subscription grant). Explicitly conflicting duplicates reject.
- A successfully granted order is reused within the adapter's scope for the
  same target (a later recovery or duplicate success does not re-run your
  server call).
- Failed grants are not cached — the next attempt retries for real.
- This only reduces duplicate client work: **server-side grant idempotency
  is still mandatory** (verify the order, persist exactly once).

### Pending-order recovery (never automatic)

```ts
const { orders } = await iap.getPendingOrders();
for (const order of orders) {
  // Runs (or reuses) the server grant FIRST; the platform's
  // completeProductGrant notification is sent only after it confirms.
  const outcome = await iap.recoverPendingOrder(order);
  // outcome.status: "completed" | "grant_failed" | "notify_failed"
}
```

SDK initialization never grants or completes pending orders by itself.

### Feature matrix

| Capability | `/rn` | `/web` | Notes |
|---|---|---|---|
| Product list | ✅ | ✅ | one-time + subscription together |
| One-time purchase | ✅ | ✅ | grant callback contract applies |
| Subscription purchase | ✅ | ✅ | `offerId` optional; `subscriptionId` surfaced on completion |
| Pending orders | ✅ | ✅ | recovery is consumer-driven |
| Grant completion notify | ✅ | ✅ | sent only after server grant confirms |
| Full-screen ads | ✅ | ➖ | ads are RN-only today |
| Notification agreement | ✅ | ✅ | event-based, one template per request |
| Share link / share sheet | ✅ | ✅ | `intoss://` paths; `completed` ≠ shared |
| Unsupported app version | `SdkError("UNSUPPORTED")` | same | per-function `isSupported` gates |

Notification and sharing adapters ship in both entries (see below).

## Login, anonymous identity, and storage (RN + Web)

```ts
import { createReactNativeIdentity, createReactNativeStorage } from "@ait-kit/sdk/rn";
// or: import { createWebIdentity, createWebStorage } from "@ait-kit/sdk/web";

const identity = createReactNativeIdentity();

// 1. Login: the adapter validates and preserves authorizationCode/referrer.
const login = await identity.login();
//    Forward BOTH values to YOUR server for the token exchange
//    (@ait-kit/api-core exposes the server-side endpoint) and create the
//    application session there. The adapter never performs the exchange.

// 2. Anonymous key: { type: "HASH", hash } or a typed error — never a
//    fabricated key.
const anon = await identity.getAnonymousKey();

// 3. Storage: string values, verbatim keys.
const storage = createReactNativeStorage();
await storage.set("cart:items", "[]");
const raw = await storage.get("cart:items"); // string | null
await storage.remove("cart:items");
```

Contracts:

- **Login** results are validated (`authorizationCode` non-empty, `referrer`
  one of the documented values) and preserved verbatim. Malformed results
  reject with `SdkError("INVALID_LOGIN_RESULT")`; unsupported environments
  with `UNSUPPORTED`; SDK rejections propagate unchanged.
- **Anonymous key** results must be the documented `{ type: "HASH", hash }`
  shape. Anything else (including the official SDK's `"ERROR"` sentinel)
  rejects with `SdkError("INVALID_ANONYMOUS_KEY")` — the adapter never
  invents a key. One exception: on React Native the official
  `getAnonymousKey()` resolves `undefined` when the installed app is below
  the feature's minimum version, which rejects with
  `SdkError("UNSUPPORTED")` instead — an unsupported environment, not a
  malformed key.
- **Storage** keys and string values pass through byte-for-byte: no
  namespace prefixing, no key transformation. Compose namespaced keys
  yourself (e.g. `cart:items`). `get` resolves `null` for missing keys;
  `set`/`remove` rejections propagate so failures stay observable.
- **No environment guessing**: the defaults never substitute a fake login
  or storage based on the runtime. For development, inject an explicit
  replacement via the `framework` option.
- Session invalidation when the anonymous identifier changes, migration of
  previously stored keys, and bootstrap sequencing stay with the consumer.

## Notification agreement and sharing (RN + Web)

```ts
import {
  createReactNativeNotification,
  createReactNativeShare
} from "@ait-kit/sdk/rn";
// or: import { createWebNotification, createWebShare } from "@ait-kit/sdk/web";

// 1. Notification agreement: one template, one request.
const notification = createReactNativeNotification();
const result = await notification.requestAgreement("TEMPLATE_CODE");
// result.status: "agreed" (newAgreement | alreadyAgreed) | "rejected"
//              | "failed" | "timeout"
// result.templateCode and result.sourceEvent are preserved verbatim. The
// outcome describes ONLY this request — it is not the user's global
// notification setting, nor any server-persisted consent state. Syncing
// consent to your server (and any smart-message sending) is your job.

// 2. Share links: intoss:// deeplink paths, optional OG image.
const share = createReactNativeShare();
const link = await share.createLink("intoss://my-app/about", "https://cdn/og.png");

// 3. Share sheet: "completed" means the SDK share call finished — nothing more.
const uiResult = await share.sendMessage(`check this out ${link}`);
// uiResult.status: "completed" | "failed" — completed does NOT prove the
// user shared and never grants share-reward eligibility.
```

Contracts:

- **Agreement** runs on the shared event-flow base: settle-once, duplicate/
  late-event immunity, single error-swallowing cleanup, registration-throw
  recovery, one overall deadline (`timeoutMs`, default 60s). SDK errors keep
  their `code`/`reason`; timeouts report `timeout` with the template.
- **Share links** validate the documented `intoss://` path contract
  (`INVALID_SHARE_PATH` otherwise) and pass the resolved link through
  verbatim. OG image generation is the consumer's concern.
- **Share sheet** resolution is `completed`, meaning ONLY that the SDK share
  call finished — the underlying SDKs do not report whether the sheet opened,
  closed, or the user actually shared. Reward grants and completion tracking
  stay with the consumer. (Renamed from `closed` in 0.3.0; see Migrating.)
- Unsupported surfaces/app versions reject with `SdkError("UNSUPPORTED")`.

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

## Verified official SDK versions

The adapters are developed and continuously checked against these exact
official releases (see `scripts/test-package-tarballs.mjs`):

| Official package | Verified version | Peer range |
|---|---|---|
| `@apps-in-toss/framework` (RN) | 2.10.10 | `>=2.10.10` |
| `@apps-in-toss/web-framework` (Web) | 3.4.0 | `>=3.4.0` |

Older versions may work where the runtime surfaces match (every capability
is checked per function and missing ones reject with `UNSUPPORTED`), but
only the versions above are verified. Newer versions are expected to work
via the same structural checks; if an official export shape changes, the
per-operation errors surface it instead of silent misbehavior.

## Migrating

### 0.3.0 — share sheet result `closed` → `completed`

`sendMessage` now resolves `{ status: "completed" }` instead of
`{ status: "closed" }`. The meaning also got precise: `completed` states
only that the SDK share **call** finished. It does not prove the share
sheet opened or closed, that the user shared, or that any reward
eligibility was earned. Update any `status === "closed"` checks; failure
results (`status: "failed"` with `code`/`reason`) are unchanged.

### 0.3.0 — RN adapters call the official export shapes

The React Native default loaders now convert the official flat exports
(`appLogin`, `getAnonymousKey`, `requestNotificationAgreement`,
`getTossShareLink`, `share`) into the shared adapter contracts. Previously
a correctly installed official RN SDK still produced
`SdkError("UNSUPPORTED")` for these five capabilities because the loaders
looked for the web SDK's namespaced shapes. Custom `framework` injections
using the internal namespaced contract or a loader keep working unchanged.

One error-mapping change rides along: the official RN `getAnonymousKey()`
resolving `undefined` (installed app below the feature's minimum version)
now rejects with `SdkError("UNSUPPORTED")` instead of
`INVALID_ANONYMOUS_KEY`; the `"ERROR"` sentinel still rejects with
`INVALID_ANONYMOUS_KEY`.
