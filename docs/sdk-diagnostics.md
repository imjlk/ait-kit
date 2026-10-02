# SDK operation diagnostics

`createSdkDiagnostics` is an opt-in, runtime-neutral observer exported by `@ait-kit/sdk`. Wrap calls at the consumer boundary so the original receiver and provider behavior are preserved:

```ts
const diagnostics = createSdkDiagnostics({ enabled: debugEnabled, sink: event => console.info(event) });
const result = await diagnostics.run('login', () => identity.login());
```

Only fixed operation labels, start/finish, a local sequence, duration and a coarse outcome are retained. No input arguments, SDK results, URLs, tokens, user keys or native errors are passed to the sink. The history holds at most 200 events, is memory-only and supports `clear()`. A sink that throws or rejects cannot affect the SDK call. Logging is disabled by default; there is no auto-upload or console/fetch patch.

The exported operation allowlist is frozen at runtime, including for JavaScript consumers. `durationMs` is omitted if either clock reading fails, is non-finite, moves backwards or produces a non-finite elapsed time. The original operation result or rejection is still preserved.

`resolved` means the wrapped call resolved. A returned `{status: 'failed'}` is still `resolved`; inspect the unchanged SDK result to decide UI behavior. A fulfilled share or payment call is not proof of sharing, entitlement or a reward. The observer does not race calls with its own timer, cancel, retry or initiate SDK operations.

Use official WebView debug tools on an uploaded test bundle for Log/Network/Element inspection. Do not assume the same WebView inspector exists for React Native. RN may use a consumer-owned debug panel or an explicitly configured error sink. Keep source SHA, bundle hash and deployment ID in the app's release evidence, not in arbitrary per-call metadata.
