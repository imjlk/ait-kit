# @ait-kit/api-cloudflare-service

Cloudflare `WorkerEntrypoint` service binding provider for typed Apps in Toss server APIs.

```bash
npm install @ait-kit/api-cloudflare-service
```

```ts
export { default } from "@ait-kit/api-cloudflare-service";
```

Anonymous users authenticate through the `exchangeAnonAuthCode({ code })` RPC
method, or the bearer-authenticated `POST /internal/apps-in-toss/anonymous-key/exchange`
fetch fallback. It exchanges a single-use SDK 3.6+ auth code for
`{ ok: true, anonKey }` once, with no retries. `verifyAnonKey` only checks that
a key exists; it does not authenticate the caller. Exchange requires forward
mode; stub mode returns `FORWARD_MODE_REQUIRED`.

Bind an mTLS certificate as `TOSS_CERT` before enabling forward mode. See the
[AIT Kit repository](https://github.com/imjlk/ait-kit) for the deployable Worker template.
