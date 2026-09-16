import { os } from "@orpc/server";
import type { PublicApiContext } from "./types.js";
import { healthInputSchema, healthOutputSchema, smartMessageOutputSchema, smartMessageSendInputSchema } from "./schemas.js";

const publicProcedure = os.$context<PublicApiContext>();

export const publicRouter = {
  health: publicProcedure
    .input(healthInputSchema)
    .output(healthOutputSchema)
    .handler(async ({ context }) => {
      return context.tossApi.health();
    }),
  smartMessage: {
    send: publicProcedure
      .input(smartMessageSendInputSchema)
      .output(smartMessageOutputSchema)
      .handler(async ({ input, context }) => {
        return context.tossApi.smartMessageSend(input);
      })
  }
};

export type PublicRouter = typeof publicRouter;
