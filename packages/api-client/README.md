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
`REQUEST_FAILED` also covers failures to convert a fully received response
into a fetch `Response` — for example a raw status outside the Fetch status
range (600), which the `Response` constructor rejects: the request rejects
with the original conversion exception preserved as `cause`, valid 4xx/5xx
responses still resolve as HTTP responses, and an already-settled timeout or
abort outcome is never overwritten by a late conversion error.

Supported runtimes for `/node`: verified with Bun 1.4.0 (test suite) and
Node.js 26.4.0 (test-suite child processes plus tarball consumer checks);
CI pins Bun 1.4.2 and Node.js 24 for the same checks.

## Verifying a published release (repository tooling)

From the [AIT Kit repository](https://github.com/imjlk/ait-kit), the mTLS
contract of an **npm-published** release can be re-verified end to end. The
command accepts an exact version only (ranges and dist-tags are rejected),
installs that release from the npm registry into an isolated throwaway
consumer project, resolves `@ait-kit/api-client/node` from that project's
own `node_modules`, and runs the same five-scenario mTLS contract used for
repository builds and tarball checks (normal 200 with client-certificate
verification, overall deadline, broken body, status-600 conversion failure
with `cause` preserved, reuse after failure):

```bash
bun run verify:published:node -- --version 0.4.1 --report ./verify-report.json
```

`--report <path>` (optional) writes a JSON report that survives cleanup:
requested and actually-installed `api-client`/`api-core` versions, the
resolved module path with proof it lives inside the installed package,
runtime versions, per-scenario outcomes, child exit code/signal, and the
verification tooling's own commit (kept separate from the release commit,
which npm metadata cannot confirm — it is reported as `unknown` when not
independently established). Registry propagation delay right after a
publish is retried within a finite budget; the command only installs and
verifies — it never publishes or modifies repository build output.

Interpretation: a passing run proves the mTLS transport contract of that
exact published version against a local loopback test server. It is not a
check against the real Toss production API, and it says nothing about
server-side ledgers or SDK integrations consuming this package.

See the [AIT Kit repository](https://github.com/imjlk/ait-kit) for proxy configuration and API
examples.
