import { publicError } from "@ait-kit/api-core";
import type { AppsInTossApiRpc } from "@ait-kit/api-core";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

export interface FetchFallbackOptions {
  bearerToken?: string;
}

export async function handleFetchFallback(
  request: Request,
  rpc: AppsInTossApiRpc,
  options: FetchFallbackOptions = {}
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/internal/apps-in-toss/health") {
      return json(await rpc.health());
    }
    const postHandler = request.method === "POST" ? resolvePostHandler(url.pathname, rpc) : undefined;
    if (!postHandler) {
      return json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    }
    if (!options.bearerToken) {
      return json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
    }
    if (!(await hasValidBearerToken(request, options.bearerToken))) {
      return json(
        { ok: false, error: "UNAUTHORIZED" },
        { status: 401, headers: { "www-authenticate": "Bearer" } }
      );
    }
    return json(await postHandler(await request.json()));
  } catch (error) {
    const safe = publicError(error);
    return json({ ok: false, error: safe.code, message: safe.message }, { status: safe.status });
  }
}

function resolvePostHandler(pathname: string, rpc: AppsInTossApiRpc) {
  switch (pathname) {
    case "/internal/mtls/request":
      return (body: Parameters<AppsInTossApiRpc["genericMtlsRequest"]>[0]) => rpc.genericMtlsRequest(body);
    case "/internal/apps-in-toss/toss-login/complete":
      return (body: Parameters<AppsInTossApiRpc["tossLoginComplete"]>[0]) => rpc.tossLoginComplete(body);
    case "/internal/apps-in-toss/toss-login/remove-by-user-key":
      return (body: Parameters<AppsInTossApiRpc["tossLoginRemoveByUserKey"]>[0]) => rpc.tossLoginRemoveByUserKey(body);
    case "/internal/apps-in-toss/iap/order/status":
      return (body: Parameters<AppsInTossApiRpc["iapOrderStatus"]>[0]) => rpc.iapOrderStatus(body);
    case "/internal/apps-in-toss/promotion/reward/grant":
      return (body: Parameters<AppsInTossApiRpc["promotionRewardGrant"]>[0]) => rpc.promotionRewardGrant(body);
    case "/internal/apps-in-toss/smart-message/send":
      return (body: Parameters<AppsInTossApiRpc["smartMessageSend"]>[0]) => rpc.smartMessageSend(body);
    case "/internal/apps-in-toss/smart-message/send-bulk":
      return (body: Parameters<AppsInTossApiRpc["smartMessageBulkSend"]>[0]) => rpc.smartMessageBulkSend(body);
    default:
      return undefined;
  }
}

async function hasValidBearerToken(request: Request, expected: string) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const provided = match?.[1] ?? "";
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (left: ArrayBuffer, right: ArrayBuffer) => boolean;
  };
  // Workers extends SubtleCrypto with timingSafeEqual; Bun-based tests use the portable fallback.
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(providedHash, expectedHash);
  }

  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

function json(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      ...JSON_HEADERS,
      ...init.headers
    }
  });
}
