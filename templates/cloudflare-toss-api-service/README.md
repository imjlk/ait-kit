# Cloudflare Toss API Service

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/imjlk/ait-kit/tree/main/templates/cloudflare-toss-api-service)

This template deploys the internal Apps in Toss API Service Worker. It exposes
typed Service Binding RPC methods such as `iapOrderStatus`,
`promotionRewardGrant`, `smartMessageSend`, and `smartMessageBulkSend`.

The Worker defaults to stub mode so the template can be deployed before mTLS
certificate material is configured. Its `fetch` handler is only a smoke/debug
fallback; production Pages or Workers should call it through Service Binding RPC.
The template disables `workers.dev` and preview URLs by default.

Consumers that bind this Worker as a service should use the
`AppsInTossApiService` entrypoint:

```jsonc
{
  "services": [
    {
      "binding": "APPS_IN_TOSS_API",
      "service": "ait-kit-toss-api-service",
      "entrypoint": "AppsInTossApiService"
    }
  ]
}
```

## Local Check

```bash
bun install
bun run deploy:dry-run
```

## Forward Mode

Upload the Toss Console certificate pair to Cloudflare:

```bash
wrangler mtls-certificate upload --cert path/to/client.crt --key path/to/client.key --name toss-api
```

Then update `wrangler.jsonc`:

```jsonc
{
  "vars": {
      "TOSS_API_MODE": "forward",
      "TOSS_API_BASE_URL": "https://apps-in-toss-api.toss.im"
    },
  "mtls_certificates": [
    {
      "binding": "TOSS_CERT",
      "certificate_id": "<uploaded-certificate-id>"
    }
  ]
}
```

`/internal/apps-in-toss/health` returns `ready: false` when forward mode is set
but `TOSS_CERT` is not configured.

## Raw mTLS relay

The generic `/internal/mtls/request` fallback and corresponding Service Binding
RPC method are disabled unless `TOSS_ALLOW_RAW_MTLS` is set to `"true"` or `"1"`.
Keep it disabled for public-facing Workers.

## HTTP fallback

POST fallback routes are disabled unless `TOSS_HTTP_BEARER_TOKEN` is configured
as a Worker secret. If you intentionally attach a route, configure it with:

```bash
wrangler secret put TOSS_HTTP_BEARER_TOKEN
```

Pass the same value as the `token` option to `createTossMtlsHttpClient`. The
health endpoint remains available without authentication for readiness probes.

Do not put certificate files, private keys, Toss tokens, or production `.dev.vars`
files in git.
