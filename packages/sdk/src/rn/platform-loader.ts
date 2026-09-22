import { createCachedPlatformLoader, frameworkImportError, type PlatformLoader, type PlatformLoadResult } from "../platform-loader.js";
/** Lazy platform-local import followed by capability-specific selection. */
export function createRnPlatformLoader<T>(
  select: (module: typeof import("@apps-in-toss/framework")) => PlatformLoadResult<T>,
  includeErrorDetails = true
): PlatformLoader<T> {
  return createCachedPlatformLoader(
    async () => select(await import("@apps-in-toss/framework")),
    error => frameworkImportError("@apps-in-toss/framework", error, includeErrorDetails)
  );
}
