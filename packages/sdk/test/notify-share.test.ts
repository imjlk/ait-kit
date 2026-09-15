import { describe, expect, test } from "bun:test";
import { createReactNativeNotification, createReactNativeShare } from "../src/rn";
import { createWebNotification, createWebShare } from "../src/web";

interface CapturedAgreement {
  templateCode: string;
  emit: (result: { type: string }) => void;
  error: (error: unknown) => void;
}

function fakeNotificationPlatform(overrides: { supported?: boolean } = {}) {
  const requests: CapturedAgreement[] = [];
  const platform = {
    Notification: {
      requestAgreement: Object.assign(
        (params: {
          options: { templateCode: string };
          onEvent: (result: { type: string }) => void;
          onError: (error: unknown) => void;
        }) => {
          const captured: CapturedAgreement = {
            templateCode: params.options.templateCode,
            emit: params.onEvent,
            error: params.onError
          };
          requests.push(captured);
          return () => {};
        },
        { isSupported: () => overrides.supported ?? true }
      )
    }
  };
  return { platform, requests };
}

function fakeSharePlatform(overrides: {
  linkSupported?: boolean;
  sendMessageImpl?: (message: { message: string }) => Promise<void>;
} = {}) {
  const seenLinks: Array<{ path: string; ogImageUrl?: string }> = [];
  const seenMessages: string[] = [];
  const platform = {
    Share: {
      createLink: Object.assign(
        async (params: { path: string; ogImageUrl?: string }) => {
          seenLinks.push(params);
          return `https://toss.im/intoss?d=${encodeURIComponent(params.path)}`;
        },
        { isSupported: () => overrides.linkSupported ?? true }
      ),
      sendMessage: Object.assign(
        overrides.sendMessageImpl ??
          (async (message: { message: string }) => {
            seenMessages.push(message.message);
          }),
        { isSupported: () => true }
      )
    }
  };
  return { platform, seenLinks, seenMessages };
}

describe("@ait-kit/sdk notification agreement", () => {
  test.each([
    ["newAgreement", "agreed", "newAgreement"],
    ["alreadyAgreed", "agreed", "alreadyAgreed"]
  ] as const)(
    "preserves the template and raw event for %s",
    async (eventType, status, agreement) => {
      const fake = fakeNotificationPlatform();
      const notification = createReactNativeNotification({ framework: fake.platform });

      const promise = notification.requestAgreement("TEMPLATE_1");
      await Bun.sleep(1);
      fake.requests[0].emit({ type: eventType });
      fake.requests[0].emit({ type: "agreementRejected" }); // duplicate ignored

      await expect(promise).resolves.toEqual({
        status,
        agreement,
        templateCode: "TEMPLATE_1",
        sourceEvent: { type: eventType }
      });
    }
  );

  test("reports rejection with the raw event preserved", async () => {
    const fake = fakeNotificationPlatform();
    const notification = createReactNativeNotification({ framework: fake.platform });

    const promise = notification.requestAgreement("TEMPLATE_1");
    await Bun.sleep(1);
    fake.requests[0].emit({ type: "agreementRejected" });

    await expect(promise).resolves.toEqual({
      status: "rejected",
      templateCode: "TEMPLATE_1",
      sourceEvent: { type: "agreementRejected" }
    });
  });

  test("surfaces SDK errors with code and reason", async () => {
    const fake = fakeNotificationPlatform();
    const notification = createReactNativeNotification({ framework: fake.platform });

    const promise = notification.requestAgreement("TEMPLATE_1");
    await Bun.sleep(1);
    fake.requests[0].error({ code: "UNSUPPORTED_APP_VERSION", message: "update required" });

    await expect(promise).resolves.toEqual({
      status: "failed",
      templateCode: "TEMPLATE_1",
      code: "UNSUPPORTED_APP_VERSION",
      reason: "update required"
    });
  });

  test("times out stalled requests and ignores late events", async () => {
    const fake = fakeNotificationPlatform();
    const notification = createReactNativeNotification({
      framework: fake.platform,
      timeoutMs: 20
    });

    const promise = notification.requestAgreement("TEMPLATE_1");
    await expect(promise).resolves.toMatchObject({
      status: "timeout",
      templateCode: "TEMPLATE_1"
    });

    // Late agreement never rewrites the settled timeout.
    fake.requests[0].emit({ type: "newAgreement" });
    await expect(promise).resolves.toMatchObject({ status: "timeout" });
  });

  test("rejects with UNSUPPORTED on unsupported versions and blank templates", async () => {
    const unsupported = createReactNativeNotification({
      framework: fakeNotificationPlatform({ supported: false }).platform
    });
    await expect(unsupported.requestAgreement("TEMPLATE_1")).rejects.toMatchObject({
      code: "UNSUPPORTED"
    });

    const notification = createReactNativeNotification({
      framework: fakeNotificationPlatform().platform
    });
    await expect(notification.requestAgreement("   ")).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("templateCode")
    });
  });

  test("bounds the agreement deadline across platform loading", async () => {
    const notification = createReactNativeNotification({
      framework: () => new Promise(() => {}), // loader never resolves
      timeoutMs: 20
    });

    await expect(notification.requestAgreement("TEMPLATE_1")).resolves.toMatchObject({
      status: "timeout",
      templateCode: "TEMPLATE_1"
    });
  });

  test("preserves platform event metadata in sourceEvent", async () => {
    const requests: Array<{ emit: (result: unknown) => void }> = [];
    const platform = {
      Notification: {
        requestAgreement: (params: { onEvent: (result: unknown) => void }) => {
          requests.push({ emit: params.onEvent });
          return () => {};
        }
      }
    };
    const notification = createReactNativeNotification({ framework: platform as never });

    const promise = notification.requestAgreement("TEMPLATE_1");
    await Bun.sleep(1);
    requests[0].emit({ type: "newAgreement", extra: "metadata" });

    await expect(promise).resolves.toMatchObject({
      status: "agreed",
      sourceEvent: { type: "newAgreement", extra: "metadata" }
    });
  });

  test("web notification rejects with SDK_UNAVAILABLE without the web SDK", async () => {
    const notification = createWebNotification({
      framework: async () => ({ available: false, reason: "web sdk missing" })
    });
    await expect(notification.requestAgreement("TEMPLATE_1")).rejects.toMatchObject({
      code: "SDK_UNAVAILABLE"
    });
  });
});

describe("@ait-kit/sdk share", () => {
  test("creates links with verbatim paths and optional OG images", async () => {
    const fake = fakeSharePlatform();
    const share = createReactNativeShare({ framework: fake.platform });

    const link = await share.createLink("intoss://my-app/about?name=test");
    expect(link).toContain("intoss%3A%2F%2Fmy-app");
    expect(fake.seenLinks[0]).toEqual({ path: "intoss://my-app/about?name=test" });

    await share.createLink("intoss://my-app", "https://cdn.example/og.png");
    expect(fake.seenLinks[1]).toEqual({
      path: "intoss://my-app",
      ogImageUrl: "https://cdn.example/og.png"
    });
  });

  test("rejects whitespace-padded deeplink paths", async () => {
    const share = createReactNativeShare({ framework: fakeSharePlatform().platform });

    await expect(share.createLink(" intoss://my-app")).rejects.toMatchObject({
      code: "INVALID_SHARE_PATH"
    });
    await expect(share.createLink("intoss://my-app ")).rejects.toMatchObject({
      code: "INVALID_SHARE_PATH"
    });
  });

  test("rejects non-deeplink paths with INVALID_SHARE_PATH", async () => {
    const share = createReactNativeShare({ framework: fakeSharePlatform().platform });

    await expect(share.createLink("https://example.com")).rejects.toMatchObject({
      code: "INVALID_SHARE_PATH"
    });
    await expect(share.createLink("")).rejects.toMatchObject({ code: "INVALID_SHARE_PATH" });
  });

  test("reports share sheet closure without claiming completion", async () => {
    const fake = fakeSharePlatform();
    const share = createReactNativeShare({ framework: fake.platform });

    const result = await share.sendMessage("look at this");
    expect(result).toEqual({ status: "closed" });
    expect(fake.seenMessages).toEqual(["look at this"]);
  });

  test("surfaces share failures with code and reason", async () => {
    const share = createReactNativeShare({
      framework: fakeSharePlatform({
        sendMessageImpl: async () => {
          throw { code: "SHARE_CANCELLED_UNKNOWN", message: "sheet dismissed" };
        }
      }).platform
    });

    await expect(share.sendMessage("x")).resolves.toEqual({
      status: "failed",
      code: "SHARE_CANCELLED_UNKNOWN",
      reason: "sheet dismissed"
    });
  });

  test("rejects blank messages and unsupported surfaces", async () => {
    const share = createReactNativeShare({ framework: fakeSharePlatform().platform });
    await expect(share.sendMessage("")).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("message")
    });

    const missing = createReactNativeShare({ framework: {} });
    await expect(missing.sendMessage("x")).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("Share.sendMessage")
    });
  });

  test("web share works with an injected module", async () => {
    const fake = fakeSharePlatform();
    const share = createWebShare({ framework: fake.platform });

    const link = await share.createLink("intoss://app");
    expect(typeof link).toBe("string");
    await expect(share.sendMessage("hello")).resolves.toEqual({ status: "closed" });
  });

  test("web share rejects with SDK_UNAVAILABLE without the web SDK", async () => {
    const share = createWebShare({
      framework: async () => ({ available: false, reason: "no web sdk" })
    });
    await expect(share.createLink("intoss://app")).rejects.toMatchObject({
      code: "SDK_UNAVAILABLE"
    });
  });
});
