import { RPCHandler } from "@orpc/server/fetch";
import { publicRouter } from "./public-router";
import type { PagesGatewayEnv } from "./types";

const rpcHandler = new RPCHandler(publicRouter);

export default {
  async fetch(request: Request, env: PagesGatewayEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      const serviceHealth = await env.APPS_IN_TOSS_API.health();
      return Response.json({
        ok: true,
        appEnv: env.APP_ENV ?? "unknown",
        service: serviceHealth
      });
    }

    if (url.pathname.startsWith("/rpc")) {
      const result = await rpcHandler.handle(request, {
        prefix: "/rpc",
        context: {
          tossApi: env.APPS_IN_TOSS_API
        }
      });
      if (result.matched) {
        return result.response;
      }
    }

    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<PagesGatewayEnv>;

