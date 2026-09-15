import { SdkError, type SdkStorage } from "../index.js";

/**
 * Internal platform contract for the storage adapters, shared by /rn and
 * /web. Keys and string values pass through verbatim — the adapter adds no
 * namespace prefix and performs no key transformation; consumers that want
 * namespacing compose their own keys. Rejections from the underlying SDK
 * propagate to the caller so storage failures stay observable.
 */

export interface StorageLike {
  getItem: ((key: string) => Promise<string | null>) | undefined;
  setItem: ((key: string, value: string) => Promise<void>) | undefined;
  removeItem: ((key: string) => Promise<void>) | undefined;
}

export interface StoragePlatformSdk {
  Storage?: StorageLike;
}

export type StoragePlatformLoader = () => Promise<
  { available: true; module: StoragePlatformSdk } | { available: false; reason: string }
>;

/** Requires the full get/set/remove surface up front: storage is all-or-nothing. */
export function createSdkStorageFromPlatform(platform: StoragePlatformSdk): SdkStorage {
  const storage = platform.Storage;
  if (
    !storage ||
    typeof storage.getItem !== "function" ||
    typeof storage.setItem !== "function" ||
    typeof storage.removeItem !== "function"
  ) {
    throw new SdkError("UNSUPPORTED", "the installed SDK does not expose the Storage get/set/remove APIs");
  }
  return {
    get: (key) => platform.Storage!.getItem!(key),
    set: (key, value) => platform.Storage!.setItem!(key, value),
    remove: (key) => platform.Storage!.removeItem!(key)
  };
}
