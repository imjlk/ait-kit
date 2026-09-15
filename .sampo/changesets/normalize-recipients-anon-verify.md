---
npm/@ait-kit/api-core: minor
npm/@ait-kit/api-client: minor
npm/@ait-kit/api-cloudflare-service: minor
---

Normalize message recipients and add anonymous key verification.

**Recipient contract (api-core):** new `MessageRecipient` type and `normalizeMessageRecipient` convert legacy `{ userKey, tossUserKey, anonKey }` inputs into exactly one recipient. Requests with no identifier, several identifiers, wrong types, or empty strings are rejected (`INVALID_MESSAGE_RECIPIENT` / `INVALID_CONTEXT_RECIPIENT`) identically in stub and forward mode instead of silently picking one. Single sends now carry the recipient in the official `x-toss-user-key` / `x-anon-key` headers — **fixing the previously emitted `x-user-key`, which the API does not define**; consumer proxy code that rewrote that header can be removed. Bulk sends keep recipients in `contextList` body fields. Keys are transmitted byte-for-byte; the kit never adds or strips caller-side prefixes.

**Anonymous key verification:** new `verifyAnonKey` (also `AppsInTossApi.users.verifyAnonKey`, the flat RPC, the Cloudflare service binding, a bearer-protected `/internal/apps-in-toss/users/anon-key/verify` HTTP fallback route, and `api-client.anonKeyVerify`) calls `POST /api-partner/v1/apps-in-toss/users/anon-key/verify`. Results distinguish a definitive verdict (`ok: true` with `valid: true|false`) from "no verdict obtained" (`ok: false` for timeouts, 5xx, FAIL envelopes such as errorCode 4010, or malformed responses) — service failures are never reported as invalid keys. The public oRPC router is unchanged; verification stays internal.

**Breaking (0.x):** single-message stub mode now validates recipients and `templateSetCode` like forward mode (invalid input throws instead of returning a canned response), and the single-send wire header for user recipients changed from `x-user-key` to `x-toss-user-key`.
