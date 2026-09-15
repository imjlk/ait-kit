---
npm/@ait-kit/api-core: minor
npm/@ait-kit/api-orpc: minor
---

Validate IAP and smart-message provider responses strictly, so malformed or evidence-free Toss answers can never surface as verification or delivery success.

**IAP (`iapOrderStatus`)**

- Verification evidence must be real strings: an `orderId`, `status`, or present optional field (`sku`, `statusDeterminedAt`, `reason`) arriving as a single-element array, object, number, or boolean is rejected with `error: "INVALID_RESPONSE"` — previously `String(value)` coercion let `["ORDER_1"]`-style payloads verify.
- Failure envelopes (`FAIL`, `FAILED`, `ERROR`, and now `NETWORK_ERROR`, `TIMEOUT`) produce no evidence even when a contradictory `success` payload rides along; unrecognized `resultType` values are `INVALID_RESPONSE`, never optimistic successes.
- Existing semantics are unchanged: `ok` still means a well-formed order lookup, `verified` still requires a payable status plus order-ID match, `skuCheck` still reports separately, pending states still retry normally, and optional-field absence stays valid.

**Smart messages (`smartMessageSend` / `smartMessageBulkSend`)**

- `providerStatus: "SENT"` now requires real non-negative integer count evidence; an explicit `msgCount: 0` counts. Explicit failure entries instead produce `providerStatus: "FAILED"`. An empty object, an HTML error page, a `SUCCESS` envelope without a send result, wrong-typed counts, or an unrecognized `resultType` no longer resolves as success.
- Unconfirmable outcomes return `ok: false` with `providerStatus: "UNKNOWN"` and the new internal `error: "INVALID_RESPONSE"` field (mirrored in the public oRPC output schema). `providerRequestId` correlation is preserved; a `sentAt` is never fabricated for unknown results.
- Outcome-ambiguous envelopes (`NETWORK_ERROR`, `TIMEOUT`) and 5xx responses map to `UNKNOWN` — the message may or may not have been delivered; definite failures (explicit failure entries, `FAIL`/`ERROR` envelopes, 4xx) keep `providerStatus: "FAILED"` with the provider's `providerErrorCode` preserved and distinct from the internal `error` marker. No automatic resend was added.
- Already-normalized responses round-trip only under this module's own `SENT`/`FAILED` vocabulary; arbitrary `providerStatus` strings no longer bypass validation.
- Single and bulk sends share the same rule, and results pass through the HTTP client, the Cloudflare RPC, and the authenticated HTTP fallback unchanged.
