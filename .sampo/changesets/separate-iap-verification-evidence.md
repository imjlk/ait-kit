---
npm/@ait-kit/api-core: minor
npm/@ait-kit/api-client: minor
---

Separate IAP verification evidence from request expectations in `iapOrderStatus`.

- Response `orderId`/`sku` now come exclusively from the provider payload; request values are no longer backfilled as evidence.
- New `verified` field is the grant gate: `true` only for provider-attested `PAYMENT_COMPLETED`/`PURCHASED` status with a matching provider order ID. `ok` keeps meaning "query succeeded" — do not gate grants on it.
- New `verificationCode` is required on every unverified success (`PAYMENT_INCOMPLETE`, `PAYMENT_FAILED`, `PAYMENT_REFUNDED`, `MINIAPP_MISMATCH`, `ORDER_NOT_FOUND`, `ORDER_ID_MISMATCH`, `UNKNOWN_STATUS`, `PROVIDER_STATUS_ERROR`, `STUB_EVIDENCE`). The pending re-query flow is unchanged.
- New `skuCheck` (`MATCHED`/`MISMATCHED`/`NOT_PROVIDED`) when the caller passes an expected SKU. A missing provider SKU — optional in the official API — no longer rejects a paid order and never becomes evidence.
- Success payloads missing the spec-required `orderId` or `status` now fail with `error: "INVALID_RESPONSE"`, and `normalizeIapOrderStatusResponse` requires a requested `orderId` before it will verify anything.
- Stub responses validate `orderId` like forward mode, are marked `stub: true`, and are never `verified` (`verificationCode: "STUB_EVIDENCE"`) — an accidentally stub-mode deployment cannot grant purchases on fabricated data.

**Breaking (0.x):** the success variant of `IapOrderStatusResponse` is now a discriminated union on `verified` and gains the required `orderId` field. Code that treated any `ok: true` result as a payable order must switch to `verified`; code constructing `ok: true` results must include `verified` (and `verificationCode` when false).
