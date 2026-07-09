import type { AppsInTossApiRpc } from "@ait-kit/api-core";
import type { InferRouterInputs, InferRouterOutputs, RouterClient } from "@orpc/server";
import type { PublicRouter } from "./public-router";

export interface PublicApiContext {
  tossApi: AppsInTossApiRpc;
}

export type PublicRouterClient = RouterClient<PublicRouter>;
export type PublicRouterInputs = InferRouterInputs<PublicRouter>;
export type PublicRouterOutputs = InferRouterOutputs<PublicRouter>;
