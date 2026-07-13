# @ait-kit/api-client

Typed HTTP client helpers for calling an AIT Kit mTLS proxy.

```bash
npm install @ait-kit/api-client
```

```ts
import { createTossMtlsHttpClient } from "@ait-kit/api-client";

const tossApi = createTossMtlsHttpClient({
  baseUrl: "https://internal-api.example.com",
  token: process.env.TOSS_HTTP_BEARER_TOKEN
});
```

See the [AIT Kit repository](https://github.com/imjlk/ait-kit) for proxy configuration and API
examples.
