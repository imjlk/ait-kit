---
npm/@ait-kit/api-core: minor
npm/@ait-kit/api-client: minor
---

Check who bought an in-app purchase order. `iapOrderStatus` accepts an optional purchaser, either `tossUserKey` or `anonKey`. The purchaser is sent only in the official `x-toss-user-key` / `x-anon-key` header, and the result gains `purchaserCheck.status`. `MATCHED` and `MISMATCHED` mirror the provider's `purchaserMatched`. `NOT_PROVIDED` means the provider gave no verdict, which is documented for `MINIAPP_MISMATCH`, `NOT_FOUND` and `ERROR`.

- `verified` is unchanged. Grants bound to the calling user should also require `purchaserCheck.status === "MATCHED"`, so a caller cannot redeem someone else's paid `orderId`.
- Naming both identifiers, or a blank or non-string `anonKey`, returns `error: "INVALID_PURCHASER"` without calling the provider.
- A non-boolean `purchaserMatched` is `INVALID_RESPONSE`.
- The purchaser is never echoed back, and provider failure text that repeats it is redacted.
- Requests without a purchaser behave as before.
- `@ait-kit/api-client` re-exports the new `IapPurchaserCheckStatus` type.
