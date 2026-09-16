# @ait-kit/api-client

## 0.4.1 — 2026-09-16

### Patch changes

- [3993c4e](https://github.com/imjlk/ait-kit/commit/3993c4ed313c66b3dbd04c5080fedc7e5bbd1cab) Settle Node mTLS response conversion failures through the typed error path.
  
  When the response body finished reading but converting it into a fetch Response threw — for example a raw status 600, which the Fetch Response constructor rejects — the transport had already confirmed success internally: the completion flags were set and the deadline timer plus AbortSignal listener were torn down before conversion ran, so the conversion exception escaped the event handler as an uncaught exception while the request promise stayed pending forever. Conversion now runs before any success confirmation: body concatenation, header conversion, and Response construction are protected as one stage, and a failure rejects with the existing `NodeMtlsTransportError`/`REQUEST_FAILED` contract with the original exception preserved as `cause`. Timeout and abort outcomes are never overwritten by late conversion errors, 204/205/304 and empty-body handling is unchanged, and valid 4xx/5xx responses still resolve as HTTP responses.
  
  No public signatures, options, or error codes changed; no automatic retries were added — a transport failure still never implies the upstream effect (grant, message) did not happen. Regression coverage now includes the status-600 case in the Bun test suite, in a real Node child process against the built output (watchdog-guarded, exit-code asserted), and from an installed tarball consumer exercising a full local mTLS lifecycle (200 request, deadline failure, 600 conversion failure, post-failure reuse) plus /node type compilation under bundler and NodeNext resolution. The /node declarations now carry explicit `.js` specifiers so NodeNext consumers resolve them; the api-core package's extensionless declaration chain remains a separate pre-existing issue. — Thanks @imjlk!
- Updated dependencies: api-core@0.4.1

## 0.4.0 — 2026-09-16

### Patch changes

- Updated dependencies: api-core@0.4.0

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
- [bd21c82](https://github.com/imjlk/ait-kit/commit/bd21c825672175d770fcee3cc8a4f39c72812978) Add a Node mTLS transport through the `@ait-kit/api-client/node` subpath.
  
  - `createNodeMtlsTransport({ cert, key, ca?, timeoutMs?, maxResponseBytes? })` implements api-core's `MtlsClient` on top of `node:https`, presenting your client certificate for mTLS with server verification always enabled. Certificate materials are injected as PEM strings/bytes — file discovery and environment parsing stay with the consumer.
  - One hard deadline covers DNS, connect, TLS handshake, headers, and the entire buffered body (not a socket inactivity timeout). Caller `AbortSignal`s — including pre-cancelled ones — reject immediately and destroy the in-flight request; oversized, broken, or never-completing responses reject with a typed `NodeMtlsTransportError` instead of hanging. Timers and signal listeners are cleaned up on every settle path, and the transport destroys only the requests it created.
  - The transport never retries side-effecting requests and never treats a transport failure as proof the upstream did not apply the request — error details are preserved so the promotion status flow can recover the outcome.
  - The root entry is unchanged and still free of Node-only imports; `sideEffects` is now an array that keeps root tree-shaking while preserving the node entry for bundlers. Tarball verification now also checks the `/node` runtime and type files and exercises a real request from an installed tarball under Node.
  - Verified with Node.js 26 and Bun 1.4.0 against a local mTLS server (client-certificate-enforced) covering the happy path, mid-body breakage, slowly streaming bodies, overall timeout, mid-flight cancellation, and response size limits. — Thanks @imjlk!

### Patch changes

- Updated dependencies: api-core@0.3.0

## 0.2.0 — 2026-07-13

### Minor changes

- [4ba7e17](https://github.com/imjlk/ait-kit/commit/4ba7e176008ca867714d4c1f74a063efa0631a17) Harden the typed Apps in Toss API surface with explicit DTOs, oRPC output validation, Cloudflare readiness checks, and opt-in raw mTLS relay access. — Thanks @imjlk!

### Patch changes

- [09c3c09](https://github.com/imjlk/ait-kit/commit/09c3c098bd334345a8ac3bebde8d31c1b09fec48) Align Apps in Toss promotion, IAP, and smart-message contracts, strengthen oRPC validation, and
  verify package tarballs before npm OIDC publishing. — Thanks @imjlk!
- Updated dependencies: api-core@0.2.0

## 0.1.2 — 2026-07-02

### Patch changes

- Updated dependencies: api-core@0.1.2

## 0.1.1 — 2026-07-01

### Patch changes

- [3b0a538](https://github.com/imjlk/ait-kit/commit/3b0a538dd6b968bfd177138e1e5b1d330acdb2d9) Add an HTTP proxy client package and a generic mTLS RPC alias for compatibility with existing proxy adapters. — Thanks @imjlk!
- Updated dependencies: api-core@0.1.1

