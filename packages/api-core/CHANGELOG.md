# @ait-kit/api-core

## 0.4.1 — 2026-09-16

### Patch changes

- Bumped due to fixed dependency group policy

## 0.4.0 — 2026-09-16

### Minor changes

- [d273a19](https://github.com/imjlk/ait-kit/commit/d273a193d3e795105d2e4e64b2ad89c8438bbf96) Validate IAP and smart-message provider responses strictly, so malformed or evidence-free Toss answers can never surface as verification or delivery success.
  
  **IAP (`iapOrderStatus`)**
  
  - Verification evidence must be real strings: an `orderId`, `status`, or present optional field (`sku`, `statusDeterminedAt`, `reason`) arriving as a single-element array, object, number, or boolean is rejected with `error: "INVALID_RESPONSE"` — previously `String(value)` coercion let `["ORDER_1"]`-style payloads verify.
  - Failure envelopes (`FAIL`, `FAILED`, `ERROR`, and now `NETWORK_ERROR`, `TIMEOUT`) produce no evidence even when a contradictory `success` payload rides along; unrecognized `resultType` values are `INVALID_RESPONSE`, never optimistic successes.
  - Existing semantics are unchanged: `ok` still means a well-formed order lookup, `verified` still requires a payable status plus order-ID match, `skuCheck` still reports separately, pending states still retry normally, and optional-field absence stays valid.
  
  **Smart messages (`smartMessageSend` / `smartMessageBulkSend`)**
  
  - `providerStatus: "SENT"` now requires real non-negative integer count evidence; an explicit `msgCount: 0` counts. Explicit failure entries instead produce `providerStatus: "FAILED"`. An empty object, an HTML error page, a `SUCCESS` envelope without a send result, wrong-typed counts, or an unrecognized `resultType` no longer resolves as success.
  - Unconfirmable outcomes return `ok: false` with `providerStatus: "UNKNOWN"` and the new internal `error: "INVALID_RESPONSE"` field (mirrored in the public oRPC output schema). `providerRequestId` correlation is preserved; a `sentAt` is never fabricated for unknown results.
  - Outcome-ambiguous envelopes (`NETWORK_ERROR`, `TIMEOUT`) and 5xx responses map to `UNKNOWN` — the message may or may not have been delivered; definite failures (explicit failure entries, `FAIL`/`ERROR` envelopes, 4xx) keep `providerStatus: "FAILED"` with the provider's `providerErrorCode` preserved and distinct from the internal `error` marker. No automatic resend was added.
  - Already-normalized responses round-trip only under this module's own `SENT`/`FAILED` vocabulary; arbitrary `providerStatus` strings no longer bypass validation.
  - Single and bulk sends share the same rule, and results pass through the HTTP client, the Cloudflare RPC, and the authenticated HTTP fallback unchanged. — Thanks @imjlk!

## 0.3.0 — 2026-09-15

### Minor changes

- [e9270a7](https://github.com/imjlk/ait-kit/commit/e9270a72246e244e5526115cdad9fe7ec8795aba) Separate IAP verification evidence from request expectations in `iapOrderStatus`.
  
  - Response `orderId`/`sku` now come exclusively from the provider payload; request values are no longer backfilled as evidence.
  - New `verified` field is the grant gate: `true` only for provider-attested `PAYMENT_COMPLETED`/`PURCHASED` status with a matching provider order ID. `ok` keeps meaning "query succeeded" — do not gate grants on it.
  - New `verificationCode` is required on every unverified success (`PAYMENT_INCOMPLETE`, `PAYMENT_FAILED`, `PAYMENT_REFUNDED`, `MINIAPP_MISMATCH`, `ORDER_NOT_FOUND`, `ORDER_ID_MISMATCH`, `UNKNOWN_STATUS`, `PROVIDER_STATUS_ERROR`, `STUB_EVIDENCE`). The pending re-query flow is unchanged.
  - New `skuCheck` (`MATCHED`/`MISMATCHED`/`NOT_PROVIDED`) when the caller passes an expected SKU. A missing provider SKU — optional in the official API — no longer rejects a paid order and never becomes evidence.
  - Success payloads missing the spec-required `orderId` or `status` now fail with `error: "INVALID_RESPONSE"`, and `normalizeIapOrderStatusResponse` requires a requested `orderId` before it will verify anything.
  - Stub responses validate `orderId` like forward mode, are marked `stub: true`, and are never `verified` (`verificationCode: "STUB_EVIDENCE"`) — an accidentally stub-mode deployment cannot grant purchases on fabricated data.
  
  **Breaking (0.x):** the success variant of `IapOrderStatusResponse` is now a discriminated union on `verified` and gains the required `orderId` field. Code that treated any `ok: true` result as a payable order must switch to `verified`; code constructing `ok: true` results must include `verified` (and `verificationCode` when false). — Thanks @imjlk!
- [b5c4858](https://github.com/imjlk/ait-kit/commit/b5c4858abaa55a364a207a12a53bbc15b1741334) Normalize message recipients and add anonymous key verification.
  
  **Recipient contract (api-core):** new `MessageRecipient` type and `normalizeMessageRecipient` convert legacy `{ userKey, tossUserKey, anonKey }` inputs into exactly one recipient. Requests with no identifier, several identifiers, wrong types, or empty strings are rejected (`INVALID_MESSAGE_RECIPIENT` / `INVALID_CONTEXT_RECIPIENT`) identically in stub and forward mode instead of silently picking one. Single sends now carry the recipient in the official `x-toss-user-key` / `x-anon-key` headers — **fixing the previously emitted `x-user-key`, which the API does not define**; consumer proxy code that rewrote that header can be removed. Bulk sends keep recipients in `contextList` body fields. Keys are transmitted byte-for-byte; the kit never adds or strips caller-side prefixes.
  
  **Anonymous key verification:** new `verifyAnonKey` (also `AppsInTossApi.users.verifyAnonKey`, the flat RPC, the Cloudflare service binding, a bearer-protected `/internal/apps-in-toss/users/anon-key/verify` HTTP fallback route, and `api-client.anonKeyVerify`) calls `POST /api-partner/v1/apps-in-toss/users/anon-key/verify`. Results distinguish a definitive verdict (`ok: true` with `valid: true|false`) from "no verdict obtained" (`ok: false` for timeouts, 5xx, FAIL envelopes such as errorCode 4010, or malformed responses) — service failures are never reported as invalid keys. The public oRPC router is unchanged; verification stays internal.
  
  **Breaking (0.x):** single-message stub mode now validates recipients and `templateSetCode` like forward mode (invalid input throws instead of returning a canned response), and the single-send wire header for user recipients changed from `x-user-key` to `x-toss-user-key`. — Thanks @imjlk!
- [180b78c](https://github.com/imjlk/ait-kit/commit/180b78c0cd2ffe3a62fa0fdeb500a015c46e004e) Add recoverable promotion prepare, execute, and status APIs.
  
  - `promotionPrepareReward` issues a transaction key (get-key only).
  - `promotionExecuteReward` requires an existing `providerTransactionKey` plus `promotionCode`, `amount`, and a recipient (the shared recipient contract: exactly one of `userKey`/`tossUserKey`/`anonKey`). It never issues a new key.
  - `promotionRewardStatus` reads the recorded outcome for a key with zero key-issuing and zero execute calls, so lost execute responses can be resolved by re-querying.
  
  Outcome semantics: `SUBMITTED` (accepted, not final), `UNKNOWN` (transport failure, 5xx, or unparseable response — the request may have been applied; the key is preserved and the result is never treated as a definite failure, and nothing is auto-re-executed because the official contract documents no idempotency for same-key re-execution beyond the 4113 rejection), `NOT_FOUND` (documented error 4111 — no grant record), and explicit success/failure only from provider verdicts. The API supplies no grant timestamp, so status reports `checkedAt` (observation time) instead of fabricating `grantedAt`; passing a request identifier does not make external grants idempotent.
  
  Wired through the Cloudflare service binding, bearer-protected HTTP fallback routes (`/internal/apps-in-toss/promotion/reward/prepare|execute|status`), and api-client. The public oRPC router is unchanged. The legacy `promotionRewardGrant` behavior is untouched — passing an existing key still performs a result lookup only. Stub output is marked `stub: true` and never claims `GRANTED`. The README documents the recommended consumer flow (prepare → persist the key with owner/recipient/promotionCode/amount/requestId → execute → status) and the consumer-owned ownership, concurrency, and ledger responsibilities. — Thanks @imjlk!

## 0.2.0 — 2026-07-13

### Minor changes

- [4ba7e17](https://github.com/imjlk/ait-kit/commit/4ba7e176008ca867714d4c1f74a063efa0631a17) Harden the typed Apps in Toss API surface with explicit DTOs, oRPC output validation, Cloudflare readiness checks, and opt-in raw mTLS relay access. — Thanks @imjlk!

### Patch changes

- [09c3c09](https://github.com/imjlk/ait-kit/commit/09c3c098bd334345a8ac3bebde8d31c1b09fec48) Align Apps in Toss promotion, IAP, and smart-message contracts, strengthen oRPC validation, and
  verify package tarballs before npm OIDC publishing. — Thanks @imjlk!

## 0.1.2 — 2026-07-02

### Patch changes

- [990b008](https://github.com/imjlk/ait-kit/commit/990b0085d968b1436b6d78623962519894d02ad5) Treat top-level Toss Login unlink error codes as failed upstream responses so runtime adapters can rely on core normalization. — Thanks @imjlk!

## 0.1.1 — 2026-07-01

### Patch changes

- [3b0a538](https://github.com/imjlk/ait-kit/commit/3b0a538dd6b968bfd177138e1e5b1d330acdb2d9) Add an HTTP proxy client package and a generic mTLS RPC alias for compatibility with existing proxy adapters. — Thanks @imjlk!

