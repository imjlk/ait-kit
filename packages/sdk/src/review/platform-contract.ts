/** Minimal injectable shape shared by the platform adapters. */
export interface ReviewPlatformSdk {
  Review?: {
    request?: (() => Promise<void>) & { isSupported?: () => boolean };
  };
}

export type ReviewPlatformLoader = () => Promise<
  | { available: true; module: ReviewPlatformSdk }
  | { available: false; reason: string }
>;

/** Completion only means the SDK call settled, never that a review was written. */
export interface ReviewAdapter {
  isSupported(): Promise<boolean>;
  request(): Promise<void>;
}
