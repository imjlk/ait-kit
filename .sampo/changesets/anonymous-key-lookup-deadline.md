---
npm/@ait-kit/sdk: minor
---

Share one in-flight anonymous key lookup per identity adapter (RN and WebView): concurrent `getAnonymousKey()` callers join the pending SDK call instead of starting another, so a host that never answers holds at most one bridge call, and the shared call is released as soon as it settles. Add an opt-in per-call `getAnonymousKey({ timeoutMs })` deadline that rejects only the waiting caller with the new `SdkError("TIMEOUT")` code (classified as `timeout` by diagnostics) without cancelling the shared call; invalid values reject with `INVALID_IDENTITY_INPUT`. Without `timeoutMs` there is still no deadline. `createAnonymousKeyAuthCode()` calls are never shared.
