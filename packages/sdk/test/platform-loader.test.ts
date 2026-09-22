import { expect, test } from "bun:test";
import { createCachedPlatformLoader, frameworkImportError, resolvePlatformLoader, type PlatformLoader } from "../src/platform-loader.js";

test("default loader construction stays lazy and caches only successful modules", async () => {
  let calls = 0;
  const module = { marker: "synthetic" };
  const loader = createCachedPlatformLoader(async () => {
    calls++;
    return { available: true, module };
  }, () => "failed");
  expect(calls).toBe(0);
  expect(await loader()).toEqual({ available: true, module });
  const result = await loader();
  expect(result.available && result.module).toBe(module);
  expect(calls).toBe(1);
});

test("unavailable selections and thrown imports are retried until success", async () => {
  let calls = 0;
  const load = createCachedPlatformLoader(async () => {
    calls++;
    if (calls === 1) throw new Error("synthetic import failure");
    if (calls === 2) return { available: false, reason: "domain missing" };
    return { available: true, module: { ready: true } };
  }, error => frameworkImportError("synthetic-sdk", error, true));
  expect(await load()).toEqual({ available: false, reason: "failed to import synthetic-sdk: synthetic import failure" });
  expect(await load()).toEqual({ available: false, reason: "domain missing" });
  expect(await load()).toEqual({ available: true, module: { ready: true } });
  await load();
  expect(calls).toBe(3);
});

test("synchronous selection errors become unavailable and are not cached", async () => {
  let calls = 0;
  const loader = createCachedPlatformLoader(() => {
    calls++;
    throw new Error("synthetic detail");
  }, error => frameworkImportError("synthetic-sdk", error, false));
  expect(await loader()).toEqual({ available: false, reason: "failed to import synthetic-sdk" });
  await loader();
  expect(calls).toBe(2);
});

test("injected loaders are preserved without caching or invoking defaults", async () => {
  let calls = 0;
  let defaults = 0;
  const injected: PlatformLoader<{ count: number }> = async () => ({ available: true, module: { count: ++calls } });
  const factory = () => { defaults++; return injected; };
  const loader = resolvePlatformLoader(injected, factory);
  expect(loader).toBe(injected);
  expect(await loader()).toEqual({ available: true, module: { count: 1 } });
  expect(await loader()).toEqual({ available: true, module: { count: 2 } });
  const module = { count: 10 };
  const objectLoader = resolvePlatformLoader(module, factory);
  const result = await objectLoader();
  expect(result.available && result.module).toBe(module);
  expect(defaults).toBe(0);
  expect(resolvePlatformLoader(undefined, factory)).toBe(injected);
  expect(defaults).toBe(1);
});

test("separate loader instances do not share cached modules", async () => {
  let calls = 0;
  const make = () => createCachedPlatformLoader(async () => ({ available: true, module: { id: ++calls } }), () => "failed");
  const first = make();
  const second = make();
  expect(await first()).toEqual({ available: true, module: { id: 1 } });
  expect(await second()).toEqual({ available: true, module: { id: 2 } });
  expect(await first()).toEqual({ available: true, module: { id: 1 } });
});

test("redacted diagnostics never stringify an untrusted thrown value", () => {
  const error = { toString() { throw new Error("must not inspect"); } };
  expect(frameworkImportError("synthetic-sdk", error, false)).toBe("failed to import synthetic-sdk");
  expect(frameworkImportError("synthetic-sdk", "synthetic failure", true)).toBe("failed to import synthetic-sdk: synthetic failure");
});
