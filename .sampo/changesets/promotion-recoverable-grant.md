---
npm/@ait-kit/api-core: minor
npm/@ait-kit/api-client: minor
npm/@ait-kit/api-cloudflare-service: minor
---

Add recoverable promotion prepare, execute, and status APIs.

- `promotionPrepareReward` issues a transaction key (get-key only).
- `promotionExecuteReward` requires an existing `providerTransactionKey` plus `promotionCode`, `amount`, and a recipient (the shared recipient contract: exactly one of `userKey`/`tossUserKey`/`anonKey`). It never issues a new key.
- `promotionRewardStatus` reads the recorded outcome for a key with zero key-issuing and zero execute calls, so lost execute responses can be resolved by re-querying.

Outcome semantics: `SUBMITTED` (accepted, not final), `UNKNOWN` (transport failure, 5xx, or unparseable response — the request may have been applied; the key is preserved and the result is never treated as a definite failure, and nothing is auto-re-executed because the official contract documents no idempotency for same-key re-execution beyond the 4113 rejection), `NOT_FOUND` (documented error 4111 — no grant record), and explicit success/failure only from provider verdicts. The API supplies no grant timestamp, so status reports `checkedAt` (observation time) instead of fabricating `grantedAt`; passing a request identifier does not make external grants idempotent.

Wired through the Cloudflare service binding, bearer-protected HTTP fallback routes (`/internal/apps-in-toss/promotion/reward/prepare|execute|status`), and api-client. The public oRPC router is unchanged. The legacy `promotionRewardGrant` behavior is untouched — passing an existing key still performs a result lookup only. Stub output is marked `stub: true` and never claims `GRANTED`. The README documents the recommended consumer flow (prepare → persist the key with owner/recipient/promotionCode/amount/requestId → execute → status) and the consumer-owned ownership, concurrency, and ledger responsibilities.
