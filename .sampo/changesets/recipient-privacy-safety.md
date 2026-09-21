---
npm/@ait-kit/api-core: patch (Security)
---

Suppress recipient-bearing provider and transport failure text returned by promotion prepare, execute and status, including short identifiers, while preserving transaction keys, provider codes and outcome semantics. Shared recipient validation now rejects fractional and unsafe numeric userKey/tossUserKey values before transport in promotion and single/bulk messages. Pass large numeric identifiers as exact strings; never convert them through JavaScript Number first.
