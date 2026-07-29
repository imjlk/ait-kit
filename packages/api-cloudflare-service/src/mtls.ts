import type { MtlsClient } from "@ait-kit/api-core";

export interface CloudflareFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export function createCloudflareMtlsClient(fetcher: CloudflareFetcher): MtlsClient {
  return {
    request: (url, init) => fetcher.fetch(url, init)
  };
}

