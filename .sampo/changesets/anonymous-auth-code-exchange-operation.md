---
npm/@ait-kit/api-core: minor
npm/@ait-kit/api-client: minor
npm/@ait-kit/api-cloudflare-service: minor
---

Make the SDK 3.6+ anonymous auth-code exchange a first-class server operation, so consumers no longer wire the standalone `exchangeAnonAuthCode` helper next to the core by hand.

- `@ait-kit/api-core`: `createAppsInTossApi` exposes `users.exchangeAnonAuthCode({ code }, { signal })`, and `AppsInTossApiRpc` (`createAppsInTossApiRpc`, `createTossMtlsCore`) gains `exchangeAnonAuthCode({ code })`. Both reuse the existing helper: one upstream request per call, no retries, no caching, and `FORWARD_MODE_REQUIRED` instead of a stub identity in stub mode. Code that implements `AppsInTossApiRpc` itself (custom fakes or adapters) must add the method.
- `@ait-kit/api-client`: `PROXY_ENDPOINTS.anonAuthCodeExchange` (`/internal/apps-in-toss/anonymous-key/exchange`) and `TossMtlsHttpClient.anonAuthCodeExchange({ code })`, sent once and never retried.
- `@ait-kit/api-cloudflare-service`: `exchangeAnonAuthCode` Service Binding RPC method and the matching bearer-authenticated fetch fallback route.

`verifyAnonKey` / `anonKeyVerify` only check that a key exists; they do not prove the caller owns it. Authenticate anonymous users with the exchange.
