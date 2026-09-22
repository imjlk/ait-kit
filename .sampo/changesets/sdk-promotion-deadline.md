---
npm/@ait-kit/sdk: patch
---

Enforce the elapsed direct-promotion deadline even when synchronous SDK work or queued microtasks delay timer callbacks. Do not start payment after loading or support checks consume the deadline, and keep late SDK outcomes unknown. In-flight locks still release only when the underlying operation settles; no automatic retry is introduced.
