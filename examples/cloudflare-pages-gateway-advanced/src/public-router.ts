import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import { publicRouter as basePublicRouter, type PublicApiContext } from "@ait-kit/api-orpc";
import { joinCampaign } from "./business/campaigns";

const publicProcedure = os.$context<PublicApiContext>();

const campaignJoinInputSchema = z.object({
  campaignId: z.string().min(1),
  tossUserKey: z.string().min(1),
  providerRequestId: z.string().min(1).optional(),
  promotionCode: z.string().min(1).optional(),
  amount: z.number().int().positive().optional()
});

const campaignJoinOutputSchema = z.looseObject({
  ok: z.boolean(),
  campaignId: z.string(),
  providerStatus: z.string()
});

export const publicRouter = {
  ...basePublicRouter,
  campaign: {
    join: publicProcedure
      .input(campaignJoinInputSchema)
      .output(campaignJoinOutputSchema)
      .handler(async ({ input, context }) => {
        const result = await joinCampaign(context.tossApi, input);
        if (!result.ok) {
          throw new ORPCError("BAD_REQUEST", {
            message: "Promotion reward grant failed",
            data: result
          });
        }
        return {
          ok: true,
          campaignId: input.campaignId,
          providerStatus: result.providerStatus
        };
      })
  }
};

export type PublicRouter = typeof publicRouter;
