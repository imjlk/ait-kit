import { ORPCError, os } from "@orpc/server";
import type { PublicApiContext } from "./types";
import { campaignJoinInputSchema, healthInputSchema, smartMessageSendInputSchema } from "./schemas";

const publicProcedure = os.$context<PublicApiContext>();

export const publicRouter = {
  health: publicProcedure.input(healthInputSchema).handler(async ({ context }) => {
    return context.tossApi.health();
  }),
  campaign: {
    join: publicProcedure.input(campaignJoinInputSchema).handler(async ({ input, context }) => {
      const result = await context.tossApi.promotionRewardGrant({
        providerRequestId: input.providerRequestId ?? input.campaignId,
        tossUserKey: input.tossUserKey,
        promotionCode: input.promotionCode,
        amount: input.amount
      });
      const status = result && typeof result === "object" ? (result as Record<string, unknown>).providerStatus : undefined;
      const ok = Boolean(result && typeof result === "object" && (result as Record<string, unknown>).ok);
      if (!ok) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Promotion reward grant failed",
          data: result
        });
      }
      return {
        ok,
        campaignId: input.campaignId,
        providerStatus: status
      };
    })
  },
  smartMessage: {
    send: publicProcedure.input(smartMessageSendInputSchema).handler(async ({ input, context }) => {
      return context.tossApi.smartMessageSend(input);
    })
  }
};

export type PublicRouter = typeof publicRouter;

