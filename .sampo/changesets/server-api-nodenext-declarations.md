---
npm/@ait-kit/api-core: patch
npm/@ait-kit/api-orpc: patch
npm/@ait-kit/api-cloudflare-service: patch
---

Make the shipped server API declarations resolve under NodeNext.

The emitted `.d.ts` chains of `@ait-kit/api-core`, `@ait-kit/api-orpc`, and `@ait-kit/api-cloudflare-service` used extensionless relative specifiers (`"./types"` instead of `"./types.js"`). Under `moduleResolution: node16`/`nodenext` every such import fails with TS2834, which cascades: the whole export surface of api-core becomes unresolvable (TS2305), so `@ait-kit/api-client`'s root entry and the Cloudflare service declarations failed for NodeNext consumers even where their own specifiers were fine. Bundler resolution was unaffected, which is why workspace checks never caught it. Sources now carry the deployment-JavaScript `.js` suffix on all relative specifiers (api-core 41, api-orpc 6, api-cloudflare-service 4); clean rebuilds emit identical declarations under both resolutions. Specifier-only change: no runtime code, public names, option shapes, or response types changed, and the published 0.4.1 line is not republished.

Tarball verification now compiles the installed server declarations for an isolated ESM consumer under both Bundler and NodeNext on two pinned TypeScript versions (6.0.3 and the repository's 7.0.2 — not a claim about versions between them): the `/node` entry, the api-client root, the documented api-core + `/node` transport injection combination (`satisfies MtlsClient`, `mtlsClient` wiring, IAP/smart-message union narrowing), the api-orpc router and schema surface (with `@opentelemetry/api` installed so @orpc's optional-peer gap stays distinguishable from api-orpc's own declarations), and the Cloudflare service surface in a DOM-free Worker-typed environment. Each fixture includes `@ts-expect-error` negative checks (missing certificates, wrong primitive types, a non-Response MtlsClient, un-narrowed union access) so an `any`-weakened declaration surface fails CI as unused directives, and the installed `.d.ts` is asserted to actually carry the extension-safe specifiers before the checks run.
