import { z } from "zod";

export const healthInputSchema = z.object({}).optional();

export const healthOutputSchema = z.looseObject({
  ok: z.boolean(),
  ready: z.boolean(),
  mode: z.enum(["stub", "forward"]),
  scope: z.literal("apps-in-toss-api"),
  error: z.string().optional(),
  checks: z.object({
    mtlsClient: z.boolean(),
    rawMtlsEnabled: z.boolean()
  })
});

export const smartMessageSendInputSchema = z.object({
  tossUserKey: z.string().min(1),
  templateSetCode: z.string().min(1).optional(),
  templateCode: z.string().min(1).optional(),
  context: z.record(z.string(), z.unknown())
});

export const smartMessageOutputSchema = z.looseObject({
  ok: z.boolean(),
  providerRequestId: z.unknown().optional(),
  providerStatus: z.string(),
  resultType: z.string().optional(),
  sentAt: z.unknown().optional(),
  failureReason: z.unknown().optional(),
  providerErrorCode: z.string().optional(),
  upstreamStatus: z.number().int().optional(),
  msgCount: z.number().int().nonnegative().optional(),
  sentPushCount: z.number().int().nonnegative().optional(),
  sentInboxCount: z.number().int().nonnegative().optional(),
  detail: z.unknown().optional(),
  fail: z.unknown().optional(),
  failures: z
    .array(
      z.object({
        channel: z.string(),
        contentId: z.string().optional(),
        reachFailReason: z.string().optional()
      })
    )
    .optional(),
  contentIds: z.array(z.string()).optional()
});
