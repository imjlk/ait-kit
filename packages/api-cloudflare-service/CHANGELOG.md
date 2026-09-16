# @ait-kit/api-cloudflare-service

## 0.4.1 — 2026-09-16

### Patch changes

- Bumped due to fixed dependency group policy
- Updated dependencies: api-core@0.4.1

## 0.4.0 — 2026-09-16

### Patch changes

- Updated dependencies: api-core@0.4.0

## 0.3.0 — 2026-09-15

### Minor changes

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

- Updated dependencies: api-core@0.1.1

