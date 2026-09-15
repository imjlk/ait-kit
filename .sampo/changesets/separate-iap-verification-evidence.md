---
npm/@ait-kit/api-core: minor
npm/@ait-kit/api-client: minor
---

Separate IAP verification evidence from request expectations in `iapOrderStatus`.

- Response `orderId`/`sku` now come exclusively from the provider payload; request values are no longer backfilled as evidence.
- New `verified` field is the grant gate: `true` only for provider-attested `PAYMENT_COMPLETED`/`PURCHASED` status with a matching provider order ID. `ok` keeps meaning "query succeeded" — do not gate grants on it.
- New `verificationCode` explains every non-verified outcome (`PAYMENT_INCOMPLETE`, `PAYMENT_FAILED`, `PAYMENT_REFUNDED`, `MINIAPP_MISMATCH`, `ORDER_NOT_FOUND`, `ORDER_ID_MISMATCH`, `UNKNOWN_STATUS`, `PROVIDER_STATUS_ERROR`). The pending re-query flow is unchanged.
- New `skuCheck` (`MATCHED`/`MISMATCHED`/`NOT_PROVIDED`) when the caller passes an expected SKU. A missing provider SKU — optional in the official API — no longer rejects a paid order and never becomes evidence.
- Success payloads missing the spec-required `orderId` or `status` now fail with `error: "INVALID_RESPONSE"`.
- Stub responses validate `orderId` like forward mode and are marked `stub: true`; treat them as synthetic, never as payment evidence.

**Breaking (0.x):** `IapOrderStatusResponse` gained the required `verified` and `orderId` fields on the success variant. Code that treated any `ok: true` result as a payable order must switch to `verified`.
