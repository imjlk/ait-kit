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
      return json(await rpc.genericMtlsRequest(await request.json()));
    }
    if (request.method === "POST" && url.pathname === "/internal/apps-in-toss/toss-login/complete") {
      return json(await rpc.tossLoginComplete(await request.json()));
    }
    if (request.method === "POST" && url.pathname === "/internal/apps-in-toss/toss-login/remove-by-user-key") {
      return json(await rpc.tossLoginRemoveByUserKey(await request.json()));
    }
    if (request.method === "POST" && url.pathname === "/internal/apps-in-toss/iap/order/status") {
      return json(await rpc.iapOrderStatus(await request.json()));
    }
    if (request.method === "POST" && url.pathname === "/internal/apps-in-toss/promotion/reward/grant") {
      return json(await rpc.promotionRewardGrant(await request.json()));
    }
    if (request.method === "POST" && url.pathname === "/internal/apps-in-toss/smart-message/send") {
      return json(await rpc.smartMessageSend(await request.json()));
    }
    if (request.method === "POST" && url.pathname === "/internal/apps-in-toss/smart-message/send-bulk") {
      return json(await rpc.smartMessageBulkSend(await request.json()));
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
