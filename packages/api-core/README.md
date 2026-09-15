# @ait-kit/api-core

Runtime-neutral typed adapters for Apps in Toss server APIs and mTLS transports.

```bash
npm install @ait-kit/api-core
```

```ts
import { createAppsInTossApiRpcFromOptions } from "@ait-kit/api-core";

const tossApi = createAppsInTossApiRpcFromOptions({
  mode: "forward",
  mtlsClient
});
```

## IAP order verification contract

`iapOrderStatus` separates what the provider attested from what the caller
asked. Grant decisions must gate on `verified`, never on `ok`:

- `ok: true` — the `get-order-status` query succeeded and the provider
  returned a well-formed payload. A payload missing the spec-required
  `orderId` or `status` fails with `error: "INVALID_RESPONSE"` instead of
  being patched up from the request.
- `verified: true` — the provider-attested status is `PAYMENT_COMPLETED` or
  `PURCHASED` **and** the provider-returned `orderId` matches the request.
  Response `orderId`/`sku` come exclusively from the provider payload;
  request values are expectations, never evidence.
- `verificationCode` — required on every unverified success:
  `PAYMENT_INCOMPLETE` (retryable, the pending re-query flow is preserved),
  `PAYMENT_FAILED`, `PAYMENT_REFUNDED`, `MINIAPP_MISMATCH`,
  `ORDER_NOT_FOUND` (retryable), `ORDER_ID_MISMATCH`, `UNKNOWN_STATUS`,
  `PROVIDER_STATUS_ERROR`, or `STUB_EVIDENCE`.
- `skuCheck` — present when the caller passes an expected `sku`:
  `MATCHED`, `MISMATCHED`, or `NOT_PROVIDED`. The provider `sku` is optional
  in the official API, so a missing SKU never flips `verified`; there is no
  supplementary lookup endpoint, so incomplete evidence on a payable status
  can only be re-queried through this same call.
- `stub: true` — marks synthetic stub-mode output. Stub responses fabricate
  a `PAYMENT_COMPLETED` order for development but are never `verified`
  (`verificationCode: "STUB_EVIDENCE"`), so a deployment that accidentally
  runs in stub mode cannot grant purchases on fabricated data. Development
  flows that want to exercise grant logic must explicitly opt in by checking
  `stub: true`.

## Message recipients

`normalizeMessageRecipient` turns legacy `{ userKey, tossUserKey, anonKey }`
inputs into a single `MessageRecipient` (`{ kind: "user", userKey }` or
`{ kind: "anonymous", anonKey }`). Exactly one identifier must be supplied:
requests with none, more than one, values of the wrong type, or empty
strings are rejected (`INVALID_MESSAGE_RECIPIENT` for single sends,
`INVALID_CONTEXT_RECIPIENT` for bulk `contextList` items) — identically in
stub and forward mode. Each API converts the recipient itself:

- **Single (and test) sends** carry the recipient in request headers:
  `x-toss-user-key` for user recipients, `x-anon-key` for anonymous ones.
  (Earlier releases emitted `x-user-key`, which the official API does not
  define; consumer proxy code that rewrote the header can now be removed.)
- **Bulk sends** carry recipients in `contextList` body fields (`userKey` /
  `anonKey`), never in headers.

## Anonymous keys and verification

`verifyAnonKey` calls `POST /api-partner/v1/apps-in-toss/users/anon-key/verify`
with the key in the `x-anon-key` header. Results are tri-state:

- `{ ok: true, valid: true }` / `{ ok: true, valid: false }` — definitive
  provider verdicts.
- `{ ok: false, ... }` (`ProviderFailure`) — no verdict was obtained
  (transport failure, non-2xx, FAIL envelope such as errorCode `4010`,
  malformed response). Never translate this into `valid: false`.

**Prefixes:** the SDK's `getAnonymousKey()` resolves to `{ type: "HASH",
hash }` and the `hash` value is the key. Server APIs expect exactly that
value. Applications that decorate stored identifiers with their own prefix
(for example `anon:` or `anonymous-`) must strip their own prefix before
calling; the kit transmits keys byte-for-byte and never adds or removes
prefixes in either direction.

See the [AIT Kit repository](https://github.com/imjlk/ait-kit) for supported APIs, Cloudflare
bindings, examples, and release notes.
