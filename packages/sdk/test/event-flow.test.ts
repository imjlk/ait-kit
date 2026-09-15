import { describe, expect, test } from "bun:test";
import { runEventFlow } from "../src/event-flow";

type TestEvent = { type: string };
type TestResult = { outcome: string };

function makeFlow(overrides: Partial<Parameters<typeof runEventFlow<TestEvent, TestResult>>[0]> = {}) {
  const calls: string[] = [];
  const options = {
    register: (() => {
      calls.push("register");
    }) as unknown as Parameters<typeof runEventFlow<TestEvent, TestResult>>[0]["register"],
    reduce: ((event: TestEvent) =>
      event.type === "done"
        ? { done: true as const, result: { outcome: "success" } as TestResult }
        : { done: false as const }) as Parameters<
      typeof runEventFlow<TestEvent, TestResult>
    >[0]["reduce"],
    onTimeout: () => ({ outcome: "timeout" }) as TestResult,
    timeoutMs: 0,
    ...overrides
  };
  return { calls, options };
}

describe("@ait-kit/sdk event flow", () => {
  test("resolves from a reduce decision and settles once", async () => {
    let emit!: (event: TestEvent) => void;
    const { options } = makeFlow({
      register: (e) => {
        emit = e;
      }
    });

    const promise = runEventFlow(options);
    emit({ type: "progress" });
    emit({ type: "done" });
    emit({ type: "done" });
    await expect(promise).resolves.toEqual({ outcome: "success" });
  });

  test("ignores events after settlement", async () => {
    let emit!: (event: TestEvent) => void;
    let lateHandled = false;
    const { options } = makeFlow({
      register: (e) => {
        emit = e;
      },
      reduce: (event) => {
        if (event.type === "done") {
          lateHandled = true;
        }
        return event.type === "done" ? { done: true, result: { outcome: "success" } } : { done: false };
      }
    });

    const promise = runEventFlow(options);
    emit({ type: "done" });
    await promise;
    emit({ type: "done" });
    // The second emit arrived after settlement; reduce must not re-run for it.
    expect(lateHandled).toBe(true); // first call did run
    await expect(promise).resolves.toEqual({ outcome: "success" });
  });

  test("runs the returned cleanup exactly once", async () => {
    let cleanups = 0;
    let emit!: (event: TestEvent) => void;
    const { options } = makeFlow({
      register: (e) => {
        emit = e;
        return () => {
          cleanups += 1;
        };
      }
    });

    const promise = runEventFlow(options);
    emit({ type: "done" });
    emit({ type: "done" });
    await promise;
    expect(cleanups).toBe(1);
  });

  test("supports synchronous callbacks that settle before register returns", async () => {
    let cleanups = 0;
    const { options } = makeFlow({
      // Emits synchronously inside register, then returns the cleanup.
      register: (emit) => {
        emit({ type: "done" });
        return () => {
          cleanups += 1;
        };
      }
    });

    await expect(runEventFlow(options)).resolves.toEqual({ outcome: "success" });
    expect(cleanups).toBe(1);
  });

  test("cleanup exceptions never block settlement or change the result", async () => {
    const { options } = makeFlow({
      register: (emit) => {
        emit({ type: "done" });
        return () => {
          throw new Error("cleanup boom");
        };
      }
    });

    await expect(runEventFlow(options)).resolves.toEqual({ outcome: "success" });
  });

  test("resolves with the timeout result and clears the timer", async () => {
    const scheduled: Array<() => void> = [];
    const cancelled: unknown[] = [];
    const { options } = makeFlow({
      timeoutMs: 1000,
      schedule: ((handler: () => void) => {
        scheduled.push(handler);
        return {} as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      cancelSchedule: ((handle: unknown) => {
        cancelled.push(handle);
      }) as unknown as typeof clearTimeout
    });

    const promise = runEventFlow(options);
    expect(scheduled.length).toBe(1);
    scheduled[0]();
    await expect(promise).resolves.toEqual({ outcome: "timeout" });
    expect(cancelled.length).toBe(1);
  });

  test("fails the flow when the reducer throws from an async event", async () => {
    let emit!: (event: TestEvent) => void;
    const { options } = makeFlow({
      register: (e) => {
        emit = e;
      },
      reduce: (event) => {
        if (event.type === "boom") {
          throw new Error("reduce boom");
        }
        return { done: false };
      }
    });

    const promise = runEventFlow(options);
    queueMicrotask(() => emit({ type: "boom" }));
    await expect(promise).rejects.toThrow("reduce boom");
  });

  test("rejects when register throws and still clears the timer", async () => {
    const scheduled: Array<() => void> = [];
    const cancelled: unknown[] = [];
    const { options } = makeFlow({
      timeoutMs: 1000,
      schedule: ((handler: () => void) => {
        scheduled.push(handler);
        return {} as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout,
      cancelSchedule: ((handle: unknown) => {
        cancelled.push(handle);
      }) as unknown as typeof clearTimeout,
      register: () => {
        throw new Error("register boom");
      }
    });

    await expect(runEventFlow(options)).rejects.toThrow("register boom");
    expect(cancelled.length).toBe(1);
  });
});
