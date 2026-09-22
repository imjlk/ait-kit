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
| `@ait-kit/sdk/webview` | WebView adapters for purchases, identity, storage, notifications, sharing, reviews, and promotions. Requires the official `@apps-in-toss/web-framework`, declared as an **optional peer** and imported lazily. Never requires the React Native SDK. |

The two platform entries share one internal engine but keep completely
separate SDK connections — in JavaScript and in the shipped type
declarations — so an `/rn` consumer never installs the web package and vice
versa.

## In-app purchases (RN + WebView)

Both entries expose the same IAP surface; only the loader differs:

```ts
import { createReactNativeIap } from "@ait-kit/sdk/rn";   // or:
import { createWebViewIap } from "@ait-kit/sdk/webview";

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

| Capability | `/rn` | `/webview` | Notes |
|---|---|---|---|
| Product list | ✅ | ✅ | one-time + subscription together |
| One-time purchase | ✅ | ✅ | grant callback contract applies |
| Subscription purchase | ✅ | ✅ | `offerId` optional; `subscriptionId` surfaced on completion |
| Subscription info | ✅ | ✅ | read-only provider status and access snapshot |
| Completed/refunded orders | ✅ cursor | ✅ first page only | read-only; no automatic restore or refund actions |
| Pending orders | ✅ | ✅ | recovery is consumer-driven |
| Grant completion notify | ✅ | ✅ | sent only after server grant confirms |
| Full-screen / rewarded ads | ✅ | ✅ | reward events only; reload after each show |
| Notification agreement | ✅ | ✅ | event-based, one template per request |
| Share link / share sheet | ✅ | ✅ | `intoss://` paths; `completed` ≠ shared |
| Unsupported app version | `SdkError("UNSUPPORTED")` | same | per-function `isSupported` gates |

Notification and sharing adapters ship in both entries (see below).

## Login, anonymous identity, and storage (RN + WebView)

```ts
import { createReactNativeIdentity, createReactNativeStorage } from "@ait-kit/sdk/rn";
// or: import { createWebViewIdentity, createWebViewStorage } from "@ait-kit/sdk/webview";

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

## Notification agreement and sharing (RN + WebView)

```ts
import {
  createReactNativeNotification,
  createReactNativeShare
} from "@ait-kit/sdk/rn";
// or: import { createWebViewNotification, createWebViewShare } from "@ait-kit/sdk/webview";

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

## React Native and WebView full-screen ads

```ts
import { createReactNativeAds } from "@ait-kit/sdk/rn";

// WebView: import { createWebViewAds } from "@ait-kit/sdk/webview";
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
  `loadTimeoutMs` (default 30s) bounds loads. The deadline is a single
  budget covering SDK loading AND the provider event flow: a loader that
  consumes most of it leaves only the remainder for the event wait, and a
  fully consumed budget never registers with the provider. Timeout results
  come from the event flow's own deadline, so the subscription is cleaned
  up before the timeout settles — no orphaned listener outlives the call.
- Slot updates land inside the returned promise's settlement: a failed
  load frees its slot before the caller's `catch` resumes (an immediate
  retry starts a fresh registration), and a successful load is promoted
  before the caller's `await` resumes (an immediate show works).
- Missing or failed-to-import framework → `SdkError("SDK_UNAVAILABLE")`;
  unsupported app versions → `SdkError("UNSUPPORTED")`. Load failures are
  never permanently cached — a later call retries the import.
- By default the adapter never fabricates ad success or reward results:
  outcomes come only from the provider's events.

## Responsibility split

The SDK provides ad behavior and outcomes. Your application owns server-side
ad reward requests, user session checks, payout limits, and ledger updates.
Identity, storage, notification, and sharing adapters are also available in both entries.

## Versioning

`@ait-kit/sdk` is versioned independently from the server API packages
(`@ait-kit/api-*`), which release in lockstep with each other.

## Verified official SDK versions

The adapters are developed and continuously checked against these exact
official releases (see `scripts/test-package-tarballs.mjs`):

| Official package | Verified version | Peer range |
|---|---|---|
| `@apps-in-toss/framework` (RN) | 2.10.10 | `>=2.10.10` |
| `@apps-in-toss/web-framework` (WebView) | 3.4.0 | `>=3.4.0` |

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

## Review requests

```ts
import { createReactNativeReview } from "@ait-kit/sdk/rn";
// WebView: import { createWebViewReview } from "@ait-kit/sdk/webview";
const review = createReactNativeReview(); // share one instance across screens
if (await review.isSupported()) await review.request();
```

`ReviewAdapter` is a runtime-neutral root type. Factories accept `framework`
(shared `Review.request` contract or async loader), like the existing adapters.
RN translates the official `requestReview()` export; WebView calls `Review.request()`.
The official SDK loads only on use. Missing features/support checkers return
`false`; import failure throws `SDK_UNAVAILABLE`; support-check exceptions propagate.
`request()` rechecks support and throws `UNSUPPORTED` when unavailable.
Concurrent requests on one instance share one Promise, cleared after success or
failure. There is no retry or timeout.

`Promise<void>` completion does not establish whether UI appeared or a review
was written. Never grant rewards, unlock features, or block navigation on review
completion. Complete and persist the core action first, then start a separately
error-handled review request without awaiting it in the core flow. The consumer
owns request timing, session limits, cooldowns and storage. Do not log raw SDK
errors by default.

Official reference: [Review.request](https://developers-apps-in-toss.toss.im/documentation/sdk/domains-api/review/review.request.md)
(Android/iOS Toss 5.253.0+, checked by the SDK). Verified package surfaces:
RN 2.10.10 and WebView 3.4.0. Device UI behavior requires separate manual verification;
unit/tarball tests use injected SDKs or a stubbed native bridge.

## Explicit direct promotion rewards

```ts
import { createReactNativePromotion } from "@ait-kit/sdk/rn";
// WebView: import { createWebViewPromotion } from "@ait-kit/sdk/webview";
const promotion = createReactNativePromotion({ timeoutMs: 15_000 });
const support = await promotion.getSupport();
// RN 2.10.10 exposes no support checker: support is "unknown", not "supported".
// Opt into direct grants explicitly, with app-specific eligibility/budget checks.
```

`PromotionAdapter`, `PromotionSupport`, `PromotionGrantInput` and
`PromotionGrantResult` are runtime-neutral root types. Both factories accept
`framework` (shared `Promotion.grantReward` contract or async loader).
RN calls `grantPromotionReward({ params: { promotionCode, amount } })`;
WebView calls only `Promotion.grantReward({ promotionCode, amount })`.
There is no legacy WebView fallback or fallback to/from server payment flows.

`getSupport()` reports `unsupported` for missing functions or an explicit false
check, `supported` for a true check, and `unknown` when a function has no checker.
Import failures throw `SDK_UNAVAILABLE`; support-check exceptions propagate.
Every grant rechecks support. RN's documented `undefined` and the provider's
`UNSUPPORTED_APP_VERSION` throw `UNSUPPORTED`; malformed WebView responses stay unknown.

Input errors throw `INVALID_PROMOTION_INPUT` before loading/calling the SDK:
`promotionCode` must be non-empty without surrounding whitespace (never trimmed
into a different code), and `amount` must be a positive safe integer. Campaign
eligibility, maximum amounts and budgets remain the consumer's responsibility.

Results:

- `granted` has a non-empty `rewardKey` and means only that the SDK reported success.
- `rejected` carries an explicit documented refusal code: `4100`, `4104`, `4105`,
  `4108`, `4109`, `4110`, `4112`, or `4114`.
- `unknown` means confirmation is required: SDK exceptions/sentinels, malformed or
  contradictory responses, deadlines, `UNKNOWN_ERROR`, `4113`, or new provider
  codes. `4113` never becomes an inferred already-granted ledger state.

Provider messages and raw errors are not included in grant results. Provider codes
are retained only as bounded uppercase alphanumeric/underscore tokens; do not log
reward keys, promotion codes or whole SDK responses.

Share one adapter instance. A concurrent grant throws `PROMOTION_IN_PROGRESS`;
completed results are never cached as idempotent payments. `timeoutMs` defaults to
0 (disabled), accepts integers through 2147483647, and covers loading and the SDK
call. Elapsed time is checked before dispatch and when the SDK settles, so delayed
timer callbacks cannot start an overdue payment or turn a late result into success.
After timeout the result is unknown, but the instance stays locked until the
actual operation settles. A loader finishing after timeout never starts payment.
A late success/failure cannot change the returned timeout result. There is no
cancellation, automatic retry, or protection across instances/devices/restarts.

Consumer UI pattern (all callbacks are supplied by the app):

```ts
async function grantOnce(input, ui) {
  ui.disableGrantAction();
  try {
    const result = await promotion.grantReward(input);
    if (result.status === "unknown") {
      ui.showConfirmationRequired(); // keep disabled; never retry automatically
      return;
    }
    ui.showSdkResult(result); // client report only; not a server ledger receipt
  } catch {
    ui.showConfirmationRequired(); // do not dump raw exceptions or auto-reenable
  }
}
```

Posting a client result to a server is not independent payment verification.
Consumers requiring a server ledger must keep their existing three-stage server
payment path. This API does not require client-side mTLS certificates/proxy tokens
and does not replace TrailBase claims or owned-currency accounting.

Official reference: [Promotion.grantReward](https://developers-apps-in-toss.toss.im/documentation/sdk/domains-api/promotion/promotion.grantreward.md).
Contracts are checked against RN 2.10.10 and WebView 3.4.0 published types/code with
synthetic bridge fixtures. Device checks and official test-promotion calls remain
manual; no real promotion is invoked by tests.

### WebView naming migration

Use `@ait-kit/sdk/webview` and the `createWebView*` factories / `WebView*` types.
The legacy `@ait-kit/sdk/web` entry, `createWeb*` factories, and `Web*` types remain
available as deprecated aliases with identical behavior. The official peer package
name remains `@apps-in-toss/web-framework`.

WebView ads use the official flat `loadFullScreenAd` and `showFullScreenAd` exports.
Create them with `createWebViewAds()` from `@ait-kit/sdk/webview`; the same
load/show deadlines, single-use rules, and reward-event semantics described above apply.

### Subscription status queries

Both IAP adapters expose `getSubscriptionInfo(orderId)` and return `{ subscription }`
with the provider's `catalogId`, `status`, `expiresAt`, `isAutoRenew`,
`gracePeriodExpiresAt`, and `isAccessible` fields. Future status strings are preserved;
access is never inferred from a status string. Treat this as a provider snapshot,
not server-side entitlement verification. The query never calls `grant` or changes entitlements.

Missing capabilities, unsupported host versions, and the RN unsupported `undefined`
response throw `SdkError("UNSUPPORTED")`. Blank IDs throw `INVALID_IAP_INPUT`;
malformed payloads throw `INVALID_IAP_RESULT`. Other provider errors remain observable.

### Completed and refunded order history

`iap.getCompletedOrRefundedOrders()` returns `{ orders, hasNext, nextKey?, pagination }`.
Each order retains its provider `orderId`, `sku`, `status` (`COMPLETED` or `REFUNDED`),
and `date`. This read-only query never grants goods or revokes entitlements.

RN pages have `pagination: "cursor"`; pass `{ key: page.nextKey }` to explicitly
request the next page when `hasNext` is true and a cursor is present. WebView pages
have `pagination: "first_page_only"`: the current official WebView SDK accepts no
cursor. `hasNext` may still be true, but passing a non-null key throws `UNSUPPORTED`
before provider dispatch. Do not loop WebView page-one calls or treat them as a full restore.

Missing/unsupported capabilities throw `UNSUPPORTED`, malformed inputs throw
`INVALID_IAP_INPUT`, and malformed pages throw `INVALID_IAP_RESULT`. Other provider
errors propagate without automatic retries.
