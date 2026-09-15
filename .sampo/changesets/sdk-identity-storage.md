---
npm/@ait-kit/sdk: minor
---

Add login, anonymous identity, and storage adapters to both platform entries.

- **`createReactNativeIdentity` / `createWebIdentity`**: `login()` runs the platform's TossAuth.login and validates + preserves `authorizationCode` and `referrer` verbatim — the server token exchange and application session creation stay with the consumer (`@ait-kit/api-core` exposes the server endpoint). Malformed results reject with `INVALID_LOGIN_RESULT`; unsupported environments with `UNSUPPORTED`; SDK rejections propagate unchanged. `getAnonymousKey()` requires the documented `{ type: "HASH", hash }` shape and rejects anything else (including sentinel values) with `INVALID_ANONYMOUS_KEY` — the adapter never fabricates a key.
- **`createReactNativeStorage` / `createWebStorage`**: the `get`/`set`/`remove` contract over the SDK Storage — string values, verbatim keys (no namespace prefixing or key transformation; compose namespaced keys yourself), `null` for missing keys, and propagating `set`/`remove` rejections so storage failures stay observable.
- **No environment guessing**: defaults never switch to a fake login or storage based on the runtime; development replacements are explicit injections via the `framework` option. Shared contracts live in the SDK root (`SdkLoginResult`, `SdkAnonymousKey`, `SdkStorage`) with no TrailBase dependency. Session invalidation on anonymous-identifier change, stored-key migration, and bootstrap remain consumer responsibilities.
