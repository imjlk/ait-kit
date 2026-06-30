import { z } from "zod";

export const healthInputSchema = z.object({}).optional();

export const campaignJoinInputSchema = z.object({
  campaignId: z.string().min(1),
  tossUserKey: z.string().min(1),
  providerRequestId: z.string().min(1).optional(),
  promotionCode: z.string().min(1).optional(),
  amount: z.number().int().positive().optional()
});

export const smartMessageSendInputSchema = z.object({
  tossUserKey: z.string().min(1),
  templateSetCode: z.string().min(1).optional(),
  templateCode: z.string().min(1).optional(),
  context: z.record(z.string(), z.unknown())
});

