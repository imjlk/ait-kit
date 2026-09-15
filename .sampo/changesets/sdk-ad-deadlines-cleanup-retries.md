---
npm/@ait-kit/sdk: patch
---

Synchronize full-screen ad deadlines, cleanup, and immediate retries.

- `loadFullScreenAd` / `showFullScreenAd` now run under ONE budget each: framework loading races the full configured deadline, and whatever remains is the event flow's own deadline. Previously the event flow received a fresh full-size deadline after loading finished, so a 60ms request with a 40ms load returned its timeout at ~60ms while the internal subscription kept listening until ~100ms before cleaning up.
- Timeout results are now produced by the event flow's own deadline, so the subscription cleanup completes before the timeout result settles; the `showing`/load-slot state is released only after the subscription is gone, and a timed-out request never registers with the provider afterwards (a loader that consumes the whole budget, resolves late, or hangs forever still ends within the deadline).
- Load slot updates moved inside the returned promise's settlement: a caller that catches a load failure and immediately retries (no sleep) now starts a real new SDK registration instead of joining the stale failed promise, and a caller that awaits a load success can show immediately without hitting `AD_NOT_LOADED`. Concurrent duplicate loads still share one registration, and stale tasks still cannot promote or clear a newer task's slot.
- No behavior change to error codes, ad result shapes, the single-use show policy, or reward gating (rewards still require the provider's `userEarnedReward` event). The shared event-flow engine is untouched, so IAP and notification flows are unaffected.
