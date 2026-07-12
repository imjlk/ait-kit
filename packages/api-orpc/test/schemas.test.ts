import { describe, expect, test } from "bun:test";
import { healthOutputSchema, smartMessageOutputSchema, smartMessageSendInputSchema } from "../src";

describe("@ait-kit/api-orpc schemas", () => {
  test("preserves the discriminated health contract", () => {
    const unavailable = healthOutputSchema.parse({
      ok: false,
      ready: false,
      mode: "forward",
      scope: "apps-in-toss-api",
      error: "MISSING_MTLS_CLIENT",
      checks: { mtlsClient: false, rawMtlsEnabled: false }
    });

    expect(unavailable).toMatchObject({ ok: false, ready: false, error: "MISSING_MTLS_CLIENT" });
    expect(
      healthOutputSchema.safeParse({
        ok: true,
        ready: false,
        mode: "stub",
        scope: "apps-in-toss-api",
        checks: { mtlsClient: false, rawMtlsEnabled: false }
      }).success
    ).toBe(false);
  });

  test("requires a template and exactly one message recipient", () => {
    const valid = smartMessageSendInputSchema.parse({
      anonKey: "anonymous-user",
      templateSetCode: "template",
      context: { name: "A" }
    });

    expect(valid.anonKey).toBe("anonymous-user");
    expect(
      smartMessageSendInputSchema.safeParse({
        userKey: "user",
        anonKey: "anonymous-user",
        templateSetCode: "template",
        context: {}
      }).success
    ).toBe(false);
    expect(
      smartMessageSendInputSchema.safeParse({
        tossUserKey: "user",
        userKey: "user",
        templateSetCode: "template",
        context: {}
      }).success
    ).toBe(false);
    expect(smartMessageSendInputSchema.safeParse({ userKey: "user", context: {} }).success).toBe(false);
    expect(
      smartMessageSendInputSchema.safeParse({
        userKey: "user",
        templateSetCode: "template",
        requestedAt: -1,
        context: {}
      }).success
    ).toBe(false);
  });

  test("validates concrete smart message response fields", () => {
    const response = smartMessageOutputSchema.parse({
      ok: true,
      providerRequestId: "request-id",
      providerStatus: "SENT",
      sentAt: 123,
      msgCount: 1,
      sentSmsCount: 1,
      sentAlimtalkCount: 0,
      sentFriendtalkCount: 0
    });

    expect(response).toMatchObject({ ok: true, providerRequestId: "request-id", sentAt: 123, sentSmsCount: 1 });
    expect(
      smartMessageOutputSchema.safeParse({ ok: true, providerStatus: "SENT", sentAt: "not-a-timestamp" }).success
    ).toBe(false);
  });
});
