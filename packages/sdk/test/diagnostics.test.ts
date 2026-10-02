import { expect, test } from "bun:test";
import { createSdkDiagnostics, SDK_DIAGNOSTIC_OPERATIONS } from "../src/diagnostics.js";

test("disabled is silent and enabled preserves values, exceptions and receiver closures", async () => {
  const calls: unknown[] = [];
  const disabled = createSdkDiagnostics({ sink: event => calls.push(event) });
  const secret = { authorizationCode: "private-code", url: "https://private.invalid" };
  expect(await disabled.run("login", () => secret)).toBe(secret);
  expect(calls).toEqual([]);
  const active = createSdkDiagnostics({ enabled: true, sink: event => calls.push(event) });
  expect(await active.run("login", () => secret)).toBe(secret);
  const failure = Object.assign(new Error("secret-token"), { code: "UNSUPPORTED" });
  try { await active.run("share.open", () => { throw failure; }); } catch (error) { expect(error).toBe(failure); }
  expect(active.snapshot().at(-1)?.outcome).toBe("unsupported");
  expect(JSON.stringify(calls)).not.toContain("private-code");
  expect(JSON.stringify(calls)).not.toContain("secret-token");
});

test("bounded snapshots, hostile errors, sink failures and clock failures cannot affect the operation", async () => {
  for (const sink of [() => { throw Error("logger"); }, async () => { throw Error("logger"); }]) {
    const recorder = createSdkDiagnostics({ enabled: true, sink, capacity: 2, now: () => { throw Error(); } });
    expect(await recorder.run("ad.show", () => ({ status: "failed" }))).toEqual({ status: "failed" });
    expect(recorder.snapshot().at(-1)?.outcome).toBe("resolved");
    const error = { get code() { throw Error("hidden"); }, toString() { throw Error(); } };
    try { await recorder.run("login", () => { throw error; }); } catch (caught) { expect(caught).toBe(error); }
    expect(recorder.snapshot()).toHaveLength(2);
    expect(recorder.snapshot().at(-1)?.outcome).toBe("rejected");
    recorder.clear(); expect(recorder.snapshot()).toHaveLength(0);
  }
});

test("only fixed operation labels reach diagnostics", async () => {
  const recorder = createSdkDiagnostics({ enabled: true });
  await expect(recorder.run("user-secret" as "login", () => 1)).rejects.toThrow("Invalid diagnostic operation");
  expect(recorder.snapshot()).toEqual([]);
  const error = { code: "AD_LOAD_TIMEOUT", message: "secret" };
  try { await recorder.run("ad.load", () => { throw error; }); } catch { /* expected */ }
  expect(recorder.snapshot().at(-1)?.outcome).toBe("timeout");
});

test("JavaScript cannot change the exported operation validation authority", async () => {
  expect(Object.isFrozen(SDK_DIAGNOSTIC_OPERATIONS)).toBe(true);
  expect(Reflect.set(SDK_DIAGNOSTIC_OPERATIONS, "0", "private-user-key")).toBe(false);
  expect(Reflect.deleteProperty(SDK_DIAGNOSTIC_OPERATIONS, "0")).toBe(false);
  expect(() => Array.prototype.push.call(SDK_DIAGNOSTIC_OPERATIONS, "private-user-key")).toThrow();
  const recorder = createSdkDiagnostics({ enabled: true });
  await expect(recorder.run("login", () => "original result")).resolves.toBe("original result");
  await expect(recorder.run("private-user-key" as "login", () => 1)).rejects.toThrow();
  expect(recorder.snapshot().every(event => event.operation === "login")).toBe(true);
});

test("one invalid clock reading omits duration without changing resolution or rejection", async () => {
  for (const readings of [[null, 1_700_000_000_000], [12, null], [NaN, 20], [20, Infinity], [20, 12], [-Number.MAX_VALUE, Number.MAX_VALUE]]) {
    for (const rejected of [false, true]) {
      let index = 0;
      const recorder = createSdkDiagnostics({ enabled: true, now: () => {
        const value = readings[index++];
        if (value === null) throw Error("clock unavailable");
        return value!;
      } });
      const originalError = new Error("original error");
      const action = recorder.run("login", () => { if (rejected) throw originalError; return 42; });
      if (rejected) await expect(action).rejects.toBe(originalError);
      else await expect(action).resolves.toBe(42);
      const finish = recorder.snapshot().at(-1)!;
      expect(finish.outcome).toBe(rejected ? "rejected" : "resolved");
      expect(Object.hasOwn(finish, "durationMs")).toBe(false);
    }
  }
  let time = 0;
  const valid = createSdkDiagnostics({ enabled:true, now:() => time++ * 25 });
  await valid.run("login", () => 42);
  expect(valid.snapshot().at(-1)?.durationMs).toBe(25);
});
