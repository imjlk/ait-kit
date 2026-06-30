import { publicError } from "@ait-kit/api-core";
import type { AppsInTossApiRpc } from "@ait-kit/api-core";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8"
};

export async function handleFetchFallback(request: Request, rpc: AppsInTossApiRpc): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/internal/apps-in-toss/health") {
      return json(await rpc.health());
    }
    if (request.method === "POST" && url.pathname === "/internal/mtls/request") {
      return json(await rpc.rawMtlsRequest(await request.json()));
    }
    return json({ ok: false, error: "NOT_FOUND" }, { status: 404 });
  } catch (error) {
    const safe = publicError(error);
    return json({ ok: false, error: safe.code, message: safe.message }, { status: safe.status });
  }
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

