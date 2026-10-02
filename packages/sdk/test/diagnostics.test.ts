import { expect, test } from "bun:test";
import { createSdkDiagnostics } from "../src/diagnostics.js";

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
