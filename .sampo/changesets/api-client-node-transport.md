---
npm/@ait-kit/api-client: minor
---

Add a Node mTLS transport through the `@ait-kit/api-client/node` subpath.

- `createNodeMtlsTransport({ cert, key, ca?, timeoutMs?, maxResponseBytes? })` implements api-core's `MtlsClient` on top of `node:https`, presenting your client certificate for mTLS with server verification always enabled. Certificate materials are injected as PEM strings/bytes — file discovery and environment parsing stay with the consumer.
- One hard deadline covers DNS, connect, TLS handshake, headers, and the entire buffered body (not a socket inactivity timeout). Caller `AbortSignal`s — including pre-cancelled ones — reject immediately and destroy the in-flight request; oversized, broken, or never-completing responses reject with a typed `NodeMtlsTransportError` instead of hanging. Timers and signal listeners are cleaned up on every settle path, and the transport destroys only the requests it created.
- The transport never retries side-effecting requests and never treats a transport failure as proof the upstream did not apply the request — error details are preserved so the promotion status flow can recover the outcome.
- The root entry is unchanged and still free of Node-only imports; `sideEffects` is now an array that keeps root tree-shaking while preserving the node entry for bundlers. Tarball verification now also checks the `/node` runtime and type files and exercises a real request from an installed tarball under Node.
- Verified with Node.js 26 and Bun 1.4.0 against a local mTLS server (client-certificate-enforced) covering the happy path, mid-body breakage, slowly streaming bodies, overall timeout, mid-flight cancellation, and response size limits.
