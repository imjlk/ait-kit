/**
 * Node/Bun mTLS transport for @ait-kit.
 *
 * This subpath exists so the root entry of `@ait-kit/api-client` (the HTTP
 * client for the authenticated proxy routes) stays free of Node-only
 * dependencies. Import `@ait-kit/api-client/node` in a Node or Bun process
 * to build an {@link import("@ait-kit/api-core").MtlsClient} that presents
 * your client certificate, then inject it into api-core:
 *
 * ```ts
 * import { createNodeMtlsTransport } from "@ait-kit/api-client/node";
 * import { createAppsInTossApiRpcFromOptions } from "@ait-kit/api-core";
 *
 * const tossApi = createAppsInTossApiRpcFromOptions({
 *   mode: "forward",
 *   mtlsClient: createNodeMtlsTransport({
 *     cert: process.env.TOSS_CERT_PEM,
 *     key: process.env.TOSS_KEY_PEM
 *   })
 * });
 * ```
 */
import {
  createNodeMtlsTransport,
  NodeMtlsTransportError,
  type NodeMtlsTransportErrorCode,
  type NodeMtlsTransportOptions
} from "./mtls-transport";

export { createNodeMtlsTransport, NodeMtlsTransportError };
export type { NodeMtlsTransportOptions, NodeMtlsTransportErrorCode };
