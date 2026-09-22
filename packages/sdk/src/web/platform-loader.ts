import { createCachedPlatformLoader, frameworkImportError, type PlatformLoader, type PlatformLoadResult } from "../platform-loader.js";
/** Lazy platform-local import followed by capability-specific selection. */
export function createWebPlatformLoader<T>(
  select: (module: typeof import("@apps-in-toss/web-framework")) => PlatformLoadResult<T>,
  includeErrorDetails = true
): PlatformLoader<T> {
  return createCachedPlatformLoader(
    async () => select(await import("@apps-in-toss/web-framework")),
    error => frameworkImportError("@apps-in-toss/web-framework", error, includeErrorDetails)
  );
}
