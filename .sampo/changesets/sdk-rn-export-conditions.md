---
npm/@ait-kit/sdk: patch (Fixed)
---

Expose explicit react-native export conditions for SDK entry points so Metro can resolve require-style imports without consumer package patches. Keep the existing ESM targets and verify the packaged entry metadata.
