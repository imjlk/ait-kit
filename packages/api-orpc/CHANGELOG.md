# @ait-kit/api-orpc

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

### Patch changes

- Updated dependencies: api-core@0.4.0

## 0.3.0 — 2026-09-15

### Patch changes

- [d003f88](https://github.com/imjlk/ait-kit/commit/d003f88bc3d8c0f00386b6e6f16ef05762a38b66) Update runtime dependencies to their latest versions: `@orpc/server` 1.14.6 → 1.15.0 and `zod` 4.4.3 → 4.6.5. No public API changes. — Thanks @imjlk!
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

