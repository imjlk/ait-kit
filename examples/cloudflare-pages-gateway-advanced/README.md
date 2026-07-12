# Cloudflare Pages Gateway Advanced Example

Advanced Mode Pages gateway that serves static assets, exposes a public oRPC
surface under `/rpc`, and calls the internal Apps in Toss API Worker through a
Service Binding.

## Local Check

```bash
bun install
bun run typecheck
bun run build
```

## Service Binding

The gateway expects a service binding named `APPS_IN_TOSS_API` with the
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

Application-specific business routes belong in this example layer. The
`campaign.join` oRPC route demonstrates wrapping `promotionRewardGrant` without
adding campaign logic to the reusable `@ait-kit/api-orpc` package.
