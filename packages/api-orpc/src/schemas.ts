import { z } from "zod";

export const healthInputSchema = z.object({}).optional();

const healthOutputBase = {
  mode: z.enum(["stub", "forward"]),
  scope: z.literal("apps-in-toss-api"),
  checks: z.object({
    mtlsClient: z.boolean(),
    rawMtlsEnabled: z.boolean()
  })
};

export const healthOutputSchema = z.discriminatedUnion("ok", [
  z.looseObject({ ok: z.literal(true), ready: z.literal(true), ...healthOutputBase }),
  z.looseObject({ ok: z.literal(false), ready: z.literal(false), error: z.string(), ...healthOutputBase })
]);

export const smartMessageSendInputSchema = z
  .object({
    tossUserKey: z.string().min(1).optional(),
    userKey: z.string().min(1).optional(),
    anonKey: z.string().min(1).optional(),
    templateSetCode: z.string().min(1).optional(),
    templateCode: z.string().min(1).optional(),
    providerRequestId: z.string().min(1).optional(),
    requestedAt: z.number().finite().nonnegative().optional(),
    context: z.record(z.string(), z.unknown())
  })
  .refine((input) => Boolean(input.templateSetCode || input.templateCode), {
    message: "either templateSetCode or templateCode is required"
  })
  .refine(
    (input) => [input.tossUserKey, input.userKey, input.anonKey].filter((value) => value !== undefined).length === 1,
    {
      message: "exactly one of tossUserKey, userKey, or anonKey is required"
    }
  );

const smartMessageOutputBase = {
  providerRequestId: z.string().optional(),
  providerStatus: z.string(),
  resultType: z.string().optional(),
  sentAt: z.number().finite().optional(),
  msgCount: z.number().int().nonnegative().optional(),
  sentPushCount: z.number().int().nonnegative().optional(),
  sentInboxCount: z.number().int().nonnegative().optional(),
  sentSmsCount: z.number().int().nonnegative().optional(),
  sentAlimtalkCount: z.number().int().nonnegative().optional(),
  sentFriendtalkCount: z.number().int().nonnegative().optional(),
  detail: z.unknown().optional(),
  fail: z.unknown().optional(),
  failures: z
    .array(
      z.object({
        channel: z.string(),
        contentId: z.string().optional(),
        reachedFailReason: z.string().optional()
      })
    )
    .optional(),
  contentIds: z.array(z.string()).optional()
};

export const smartMessageOutputSchema = z.discriminatedUnion("ok", [
  z.looseObject({ ok: z.literal(true), ...smartMessageOutputBase }),
  z.looseObject({
    ok: z.literal(false),
    ...smartMessageOutputBase,
    failureReason: z.string().optional(),
    providerErrorCode: z.string().optional(),
    upstreamStatus: z.number().int().optional()
  })
]);
