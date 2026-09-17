---
npm/@ait-kit/api-core: minor
npm/@ait-kit/api-client: minor
---

Require exactly one recipient identity on promotion prepare (get-key) — a caller-facing contract change.

`promotionPrepareReward` / `prepareReward` previously accepted (and ignored) an empty input and dispatched get-key with no recipient identity, while execute and status already required one. A transaction key is bound to the recipient it was issued for, so a recipient-less prepare could mint keys no later step could honestly use. Callers must now pass exactly one of `userKey`, `tossUserKey`, or `anonKey`; the chosen recipient is sent as the single matching identity header (`x-toss-user-key` / `x-anon-key`) on the bodyless get-key request. Missing, duplicated, or malformed recipients are rejected with `INVALID_PROMOTION_RECIPIENT` (400) before any upstream request — including in explicit stub mode. Recipient values pass through byte-for-byte (no app-storage prefixes added or stripped) and never appear in logs or error messages.

The `@ait-kit/api-client` root client previously dropped the prepare body entirely (its method took no argument in practice); it now forwards the input unchanged to the proxy route, and the Service Binding / authenticated HTTP paths preserve it the same way. The legacy `promotionRewardGrant` API is unchanged and remains available; migrating consumers off it is a separate change.

Prepare success still means key issuance only — not a grant. The key must be persisted before executing; failed get-key envelopes never produce a synthetic key, key expiry is not documented by the official contract, and an already-used-key error never triggers automatic re-issuance.
