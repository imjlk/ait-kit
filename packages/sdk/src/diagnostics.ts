/** Runtime-neutral, opt-in observer. Never accepts call arguments or raw errors. */
export const SDK_DIAGNOSTIC_OPERATIONS = [
  "login", "identity.lookup", "ad.load", "ad.show", "share.link", "share.open",
  "notification.agreement", "review.request", "iap.purchase", "promotion.grant",
] as const;
export type SdkDiagnosticOperation = typeof SDK_DIAGNOSTIC_OPERATIONS[number];
export type SdkDiagnosticOutcome = "resolved" | "rejected" | "timeout" | "unsupported" | "unavailable";
export interface SdkDiagnosticEvent {
  readonly schema: "ait-sdk-diagnostic-v1";
  readonly operation: SdkDiagnosticOperation;
  readonly phase: "start" | "finish";
  readonly sequence: number;
  readonly durationMs?: number;
  readonly outcome?: SdkDiagnosticOutcome;
}
export type SdkDiagnosticSink = (event: SdkDiagnosticEvent) => unknown;

/** No network, persistence, retries, cancellation or global console patching. */
export function createSdkDiagnostics({ enabled = false, sink, capacity = 50,
  now = () => typeof performance !== "undefined" ? performance.now() : Date.now(),
}: { enabled?: boolean; sink?: SdkDiagnosticSink; capacity?: number; now?: () => number } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 200) throw new TypeError("Invalid diagnostic capacity");
  const events: SdkDiagnosticEvent[] = [];
  let sequence = 0;
  const clock = () => { try { const value = now(); return Number.isFinite(value) ? value : 0; } catch { return 0; } };
  function emit(event: SdkDiagnosticEvent) {
    const snapshot = Object.freeze(event);
    if (capacity > 0) { events.push(snapshot); if (events.length > capacity) events.shift(); }
    try { Promise.resolve(sink?.(snapshot)).catch(() => {}); } catch { /* Observers cannot change SDK behavior. */ }
  }
  return {
    /** Resolved means only that the supplied call resolved, never payment/share success. */
    async run<T>(operation: SdkDiagnosticOperation, action: () => T | Promise<T>): Promise<T> {
      if (!enabled) return action();
      if (!SDK_DIAGNOSTIC_OPERATIONS.includes(operation)) throw new TypeError("Invalid diagnostic operation");
      const id = ++sequence; const started = clock();
      emit({ schema: "ait-sdk-diagnostic-v1", operation, phase: "start", sequence: id });
      try {
        const value = await action();
        emit({ schema: "ait-sdk-diagnostic-v1", operation, phase: "finish", sequence: id,
          durationMs: Math.max(0, clock() - started), outcome: "resolved" });
        return value;
      } catch (error) {
        emit({ schema: "ait-sdk-diagnostic-v1", operation, phase: "finish", sequence: id,
          durationMs: Math.max(0, clock() - started), outcome: failureOutcome(error) });
        throw error;
      }
    },
    snapshot: (): readonly SdkDiagnosticEvent[] => events.slice(),
    clear: () => { events.length = 0; },
  };
}

function failureOutcome(error: unknown): SdkDiagnosticOutcome {
  // Read only a known code, without stringifying errors, causes or foreign objects.
  try {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "UNSUPPORTED") return "unsupported";
    if (code === "SDK_UNAVAILABLE") return "unavailable";
    if (["TIMEOUT", "AD_LOAD_TIMEOUT", "BANNER_INIT_TIMEOUT"].includes(code as string)) return "timeout";
  } catch { /* A foreign code getter may throw. */ }
  return "rejected";
}
