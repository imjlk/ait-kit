import { Buffer } from "node:buffer";
import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:https";

type TransportInput = string | Uint8Array | ArrayBuffer | null | undefined;

export interface NodeMtlsTransportOptions {
  /** PEM-encoded client certificate issued for the mini app. */
  cert: string | Uint8Array;
  /** PEM-encoded private key matching {@link cert}. */
  key: string | Uint8Array;
  /** PEM-encoded CA bundle used to verify the upstream server certificate. */
  ca?: string | Uint8Array;
  /**
   * Overall deadline covering DNS, connect, TLS handshake, response headers,
   * and the full response body. Defaults to 10000ms. This is a hard budget,
   * not a socket inactivity timeout.
   */
  timeoutMs?: number;
  /**
   * Maximum response body size in bytes. The transport buffers the entire
   * body before resolving; larger responses destroy the request and reject.
   * Defaults to 4 MiB.
   */
  maxResponseBytes?: number;
}

export type NodeMtlsTransportErrorCode =
  | "INVALID_URL"
  | "UNSUPPORTED_BODY"
  | "ALREADY_ABORTED"
  | "TIMEOUT"
  | "ABORTED"
  | "RESPONSE_TOO_LARGE"
  | "REQUEST_FAILED";

/**
 * Transport-level failure. The code and message are preserved so callers can
 * log why a request ended without a verdict — transport failures never imply
 * that an external effect (grant, message) did not happen; recover them with
 * the promotion status flow or an equivalent query.
 */
export class NodeMtlsTransportError extends Error {
  code: NodeMtlsTransportErrorCode;

  constructor(code: NodeMtlsTransportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NodeMtlsTransportError";
    this.code = code;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * Creates an {@link import("@ait-kit/api-core").MtlsClient} backed by
 * Node/Bun's `node:https`, presenting the injected client certificate for
 * mTLS. Server certificate verification always stays enabled.
 *
 * Certificate materials are injected as-is: file discovery, environment
 * parsing, and server bootstrap are the consumer's job. The returned client
 * performs exactly one attempt per request — no automatic retries — because
 * a failed transport call says nothing about whether the upstream applied it.
 */
export function createNodeMtlsTransport(options: NodeMtlsTransportOptions) {
  const cert = options.cert;
  const key = options.key;
  const ca = options.ca;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  // Non-finite budgets silently disable their guard (NaN comparisons are
  // always false), so reject them up front rather than at attack time.
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("timeoutMs must be a non-negative finite number");
  }
  if (!Number.isFinite(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("maxResponseBytes must be a positive finite number");
  }

  return {
    async request(url: string, init: RequestInit): Promise<Response> {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new NodeMtlsTransportError("INVALID_URL", `invalid request url: ${url}`);
      }
      if (parsedUrl.protocol !== "https:") {
        throw new NodeMtlsTransportError(
          "INVALID_URL",
          `mTLS transport requires an https url, received ${parsedUrl.protocol}`
        );
      }

      const body = normalizeBody(init.body);
      if (body === undefined) {
        throw new NodeMtlsTransportError(
          "UNSUPPORTED_BODY",
          "request body must be a string, Uint8Array, or ArrayBuffer"
        );
      }

      const signal = init.signal ?? null;
      if (signal?.aborted) {
        throw new NodeMtlsTransportError("ALREADY_ABORTED", "request was aborted before it started");
      }

      const headers = new Headers(init.headers);
      const requestHeaders: Record<string, string> = Object.fromEntries(headers.entries());
      const bodyBytes = body === null ? null : body instanceof ArrayBuffer ? new Uint8Array(body) : body;
      if (bodyBytes !== null) {
        // Explicit length avoids chunked transfer-encoding, which some
        // upstreams reject.
        requestHeaders["content-length"] = String(
          typeof bodyBytes === "string" ? Buffer.byteLength(bodyBytes) : bodyBytes.byteLength
        );
      }
      const requestOptions: RequestOptions = {
        method: init.method ?? "GET",
        headers: requestHeaders,
        cert: toPemMaterial(cert),
        key: toPemMaterial(key),
        ca: ca === undefined ? undefined : toPemMaterial(ca),
        // Verification always stays on; the transport offers no opt-out.
        rejectUnauthorized: true
      };

      return await new Promise<Response>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let request: ReturnType<typeof httpsRequest>;
        try {
          request = httpsRequest(parsedUrl, requestOptions);
        } catch (error) {
          // Invalid certificate material throws synchronously; surface it
          // through the same typed contract as every other failure.
          const message = error instanceof Error ? error.message : String(error);
          reject(
            new NodeMtlsTransportError("REQUEST_FAILED", `request failed: ${message}`, { cause: error })
          );
          return;
        }

        const cleanup = () => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (signal) {
            signal.removeEventListener("abort", onAbort);
          }
        };

        const settle = (error: NodeMtlsTransportError) => {
          if (settled) return;
          settled = true;
          cleanup();
          // We created this request, so we destroy it on every failure path.
          // The error listener stays attached (guarded by `settled`): destroy
          // emits a final ECONNRESET-style error that must be swallowed, and
          // the request object is garbage once the promise settles.
          request.destroy();
          reject(error);
        };

        const onAbort = () => {
          settle(new NodeMtlsTransportError("ABORTED", "request was aborted by the caller"));
        };

        const onRequestError = (error: Error) => {
          if (settled) return;
          settle(
            new NodeMtlsTransportError("REQUEST_FAILED", `request failed: ${error.message}`, {
              cause: error
            })
          );
        };

        // One hard budget across DNS, connect, TLS, headers, and the entire
        // body; the timer only clears after the body fully completes. A
        // zero budget disables the deadline, matching the root client.
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            settle(new NodeMtlsTransportError("TIMEOUT", `request timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }

        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
        request.on("error", onRequestError);

        request.on("response", (response) => {
          const chunks: Buffer[] = [];
          let received = 0;
          let completed = false;

          const fail = (error: NodeMtlsTransportError) => {
            if (completed || settled) return;
            completed = true;
            settle(error);
          };

          response.on("data", (chunk: Buffer) => {
            if (completed || settled) return;
            received += chunk.length;
            if (received > maxResponseBytes) {
              fail(
                new NodeMtlsTransportError(
                  "RESPONSE_TOO_LARGE",
                  `response body exceeded the ${maxResponseBytes} byte limit`
                )
              );
              return;
            }
            chunks.push(chunk);
          });
          response.on("aborted", () => {
            fail(
              new NodeMtlsTransportError(
                "REQUEST_FAILED",
                "response was aborted before the body completed"
              )
            );
          });
          response.on("error", (error: Error) => {
            fail(
              new NodeMtlsTransportError(
                "REQUEST_FAILED",
                `response failed: ${error.message}`,
                { cause: error }
              )
            );
          });
          response.on("close", () => {
            // A close before 'end' means the body never completed.
            if (!completed && !settled && !response.readableEnded) {
              fail(
                new NodeMtlsTransportError(
                  "REQUEST_FAILED",
                  "response connection closed before the body completed"
                )
              );
            }
          });
          response.on("end", () => {
            if (completed || settled) return;
            // Build the whole fetch Response BEFORE confirming success:
            // body concatenation, header conversion, and the Response
            // constructor can all throw (e.g. statuses outside the Fetch
            // range such as 600), and a throw after success confirmation
            // would escape this handler as an uncaught exception while the
            // request promise stays pending forever. Conversion failures
            // route through the typed failure path instead.
            try {
              const bodyBuffer = Buffer.concat(chunks);
              const status = response.statusCode ?? 200;
              // The Fetch Response constructor throws for non-null bodies on
              // null-body statuses, so those statuses always construct with
              // null. Empty bodies pass null too.
              const bodyInit =
                status === 204 || status === 205 || status === 304 || bodyBuffer.length === 0
                  ? null
                  : new Uint8Array(bodyBuffer);
              const responseHeaders = new Headers();
              for (const [name, value] of Object.entries(response.headers)) {
                if (value === undefined) continue;
                for (const item of Array.isArray(value) ? value : [value]) {
                  responseHeaders.append(name, String(item));
                }
              }
              const fetchResponse = new Response(bodyInit, {
                status,
                statusText: response.statusMessage ?? "",
                headers: responseHeaders
              });
              completed = true;
              settled = true;
              cleanup();
              resolve(fetchResponse);
            } catch (error) {
              fail(
                new NodeMtlsTransportError(
                  "REQUEST_FAILED",
                  "failed to convert the completed response into a fetch Response",
                  { cause: error }
                )
              );
            }
          });
        });

        if (bodyBytes) {
          request.write(bodyBytes);
        }
        request.end();
      });
    }
  };
}

function normalizeBody(body: BodyInit | null | undefined): TransportInput {
  if (body === null || body === undefined) {
    return null;
  }
  if (typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return body;
  }
  return undefined;
}

/** Keeps the public options free of Node-specific types for consumers. */
function toPemMaterial(value: string | Uint8Array): string | Buffer {
  return typeof value === "string" ? value : Buffer.from(value);
}
