/** Internal runtime-neutral loader primitives; no official SDK is imported here. */
export type PlatformLoadResult<T> =
  | { available: true; module: T }
  | { available: false; reason: string };
export type PlatformLoader<T> = () => Promise<PlatformLoadResult<T>>;

/** Preserve injected loaders verbatim and construct defaults only when needed. */
export function resolvePlatformLoader<T>(
  framework: T | PlatformLoader<T> | undefined,
  createDefault: () => PlatformLoader<T>
): PlatformLoader<T> {
  if (!framework) return createDefault();
  if (typeof framework === "function") return framework as PlatformLoader<T>;
  return async () => ({ available: true, module: framework });
}

/** Cache only successful selections; unavailable results and thrown loads retry. */
export function createCachedPlatformLoader<T>(
  load: PlatformLoader<T>,
  errorReason: (error: unknown) => string
): PlatformLoader<T> {
  let cached: { available: true; module: T } | undefined;
  return async () => {
    if (cached) return { available: true, module: cached.module };
    try {
      const result = await load();
      if (result.available) cached = result;
      return result;
    } catch (error) {
      return { available: false, reason: errorReason(error) };
    }
  };
}

/** Preserve existing diagnostic detail policies chosen by each adapter. */
export function frameworkImportError(packageName: string, error: unknown, includeDetails: boolean): string {
  const prefix = `failed to import ${packageName}`;
  if (!includeDetails) return prefix;
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}`;
}
