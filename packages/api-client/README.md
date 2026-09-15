# @ait-kit/api-client

Typed HTTP client helpers for calling an AIT Kit mTLS proxy.

```bash
npm install @ait-kit/api-client
```

## Two entry points, two jobs

| Entry | Use it for |
|---|---|
| `@ait-kit/api-client` (root) | Calling the **authenticated proxy routes** (`/internal/...`) of a deployed AIT Kit Worker over plain HTTPS with a bearer token. Browser/edge safe: no Node APIs. |
| `@ait-kit/api-client/node` | Building an **mTLS transport** (`MtlsClient`) you inject into `@ait-kit/api-core` so api-core itself talks to the Toss partner API over TLS with your client certificate. Node/Bun only. |

### Root: proxy HTTP client

```ts
import { createTossMtlsHttpClient } from "@ait-kit/api-client";

const tossApi = createTossMtlsHttpClient({
  baseUrl: "https://internal-api.example.com",
  token: process.env.TOSS_HTTP_BEARER_TOKEN
});
```

### `/node`: mTLS transport for api-core

```ts
import { createNodeMtlsTransport } from "@ait-kit/api-client/node";
import { createAppsInTossApiRpcFromOptions } from "@ait-kit/api-core";

const tossApi = createAppsInTossApiRpcFromOptions({
  mode: "forward",
  mtlsClient: createNodeMtlsTransport({
    cert: process.env.TOSS_CERT_PEM!, // PEM contents, not file paths
    key: process.env.TOSS_KEY_PEM!,
    ca: process.env.TOSS_CA_PEM, // optional extra CA bundle
    timeoutMs: 10_000,           // one budget: DNS + connect + TLS + headers + full body
    maxResponseBytes: 4 * 1024 * 1024
  })
});
```

Certificate and key materials are injected as PEM strings (or bytes); file
discovery, environment parsing, and TLS server setup stay in your
application. Server certificate verification is always on — there is no
opt-out. The transport performs exactly one attempt per request: it never
retries grants or message sends, and a transport failure never implies the
upstream did not apply the request — recover with the promotion status flow.

Failure behavior: the whole request (through the last body byte) shares one
deadline; caller `AbortSignal`s cancel immediately and tear down the request;
response bodies are buffered up to `maxResponseBytes` and responses that
break, exceed the limit, or never complete reject with a typed
`NodeMtlsTransportError` (`code`: `TIMEOUT`, `ABORTED`, `RESPONSE_TOO_LARGE`,
`REQUEST_FAILED`, `INVALID_URL`, `UNSUPPORTED_BODY`, `ALREADY_ABORTED`).

Supported runtimes for `/node`: verified with Node.js 26 and Bun 1.4.0 (the
versions this repository's tests and tarball smoke checks run against).

See the [AIT Kit repository](https://github.com/imjlk/ait-kit) for proxy configuration and API
examples.
