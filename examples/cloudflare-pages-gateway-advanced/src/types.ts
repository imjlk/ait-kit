import type { AppsInTossApiRpc } from "@ait-kit/api-core";

export interface PagesGatewayEnv {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  APPS_IN_TOSS_API: AppsInTossApiRpc;
  APP_ENV?: string;
}

