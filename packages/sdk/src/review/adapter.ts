import { SdkError } from "../index.js";
import type { ReviewAdapter, ReviewPlatformLoader, ReviewPlatformSdk } from "./platform-contract.js";

export function createReviewAdapter(loader: ReviewPlatformLoader): ReviewAdapter {
  let inFlight: Promise<void> | undefined;
  const load = async (): Promise<ReviewPlatformSdk> => {
    const result = await loader();
    if (!result.available) throw new SdkError("SDK_UNAVAILABLE", result.reason);
    return result.module;
  };
  const supported = (platform: ReviewPlatformSdk): boolean => {
    const request = platform.Review?.request;
    return typeof request === "function" &&
      typeof request.isSupported === "function" && request.isSupported() === true;
  };
  return {
    async isSupported() {
      return supported(await load());
    },
    request() {
      if (inFlight) return inFlight;
      // Schedule loading after publishing the lock, including reentrant loaders.
      inFlight = Promise.resolve().then(async () => {
        const platform = await load();
        if (!supported(platform)) {
          throw new SdkError("UNSUPPORTED", "review requests are not supported on this app version");
        }
        await platform.Review!.request!();
      }).finally(() => { inFlight = undefined; });
      return inFlight;
    }
  };
}
