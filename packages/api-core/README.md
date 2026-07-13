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

See the [AIT Kit repository](https://github.com/imjlk/ait-kit) for supported APIs, Cloudflare
bindings, examples, and release notes.
