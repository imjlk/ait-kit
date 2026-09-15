---
npm/@ait-kit/sdk: minor
---

Add notification agreement and sharing adapters to both platform entries.

- **`createReactNativeNotification` / `createWebNotification`**: `requestAgreement(templateCode)` runs on the shared event-flow base (settle-once, duplicate/late-event immunity, single error-swallowing cleanup, registration-throw recovery, one overall deadline). Results preserve the `templateCode` and the platform's raw event verbatim, and describe only the single request — never the user's global notification setting or a server-persisted consent state (syncing those is the consumer's job, as is any smart-message sending).
- **`createReactNativeShare` / `createWebShare`**: `createLink(path, ogImageUrl?)` validates the documented `intoss://` deeplink contract (`INVALID_SHARE_PATH` otherwise) and returns the resolved link verbatim; `sendMessage(message)` opens the native share sheet and resolves `closed` — which never proves the user actually shared and never grants share-reward eligibility. Failures keep the platform's code/reason.
- Unsupported surfaces and app versions reject with `SdkError("UNSUPPORTED")`; no new packages or subpaths. The feature-support matrix in the README now covers the new domains; OG image generation, consent server sync, and share rewards remain consumer responsibilities.
