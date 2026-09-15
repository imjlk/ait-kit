import { describe, expect, test } from "bun:test";
import {
  createReactNativeIdentity,
  createReactNativeNotification,
  createReactNativeShare
} from "../src/rn";
import { SdkError } from "../src/index.js";
import {
  adaptOfficialRnIdentity,
  adaptOfficialRnNotification,
  adaptOfficialRnShare
} from "../src/rn/official-module.js";
import { officialModule } from "./helpers/official-fake.js";

describe("RN official-module conversion (identity)", () => {
  test("appLogin is wired to login and preserves the validated result", async () => {
    const identity = createReactNativeIdentity({
      framework: adaptOfficialRnIdentity(officialModule())
    });

    await expect(identity.login()).resolves.toEqual({
      authorizationCode: "code-1",
      referrer: "SANDBOX"
    });
  });

  test("official functions are called with the module as receiver", async () => {
    const official = officialModule();
    const identity = createReactNativeIdentity({ framework: adaptOfficialRnIdentity(official) });

    await identity.login();
    await identity.getAnonymousKey();
    expect(official.calls.appLogin).toEqual(["official-module"]);
    expect(official.calls.getAnonymousKey).toEqual(["official-module"]);
  });

  test("getAnonymousKey maps the undefined sentinel to UNSUPPORTED", async () => {
    const official = officialModule({ getAnonymousKey: () => Promise.resolve(undefined) });
    const identity = createReactNativeIdentity({ framework: adaptOfficialRnIdentity(official) });

    await expect(identity.getAnonymousKey()).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("does not support getAnonymousKey")
    });
  });

  test("getAnonymousKey keeps the ERROR sentinel for the shared validator", async () => {
    const official = officialModule({ getAnonymousKey: () => Promise.resolve("ERROR") });
    const identity = createReactNativeIdentity({ framework: adaptOfficialRnIdentity(official) });

    await expect(identity.getAnonymousKey()).rejects.toMatchObject({
      code: "INVALID_ANONYMOUS_KEY"
    });
  });

  test("partial official modules leave missing capabilities UNSUPPORTED", async () => {
    // getAnonymousKey present, appLogin absent.
    const official = { getAnonymousKey: officialModule().getAnonymousKey };
    const identity = createReactNativeIdentity({ framework: adaptOfficialRnIdentity(official) });

    await expect(identity.login()).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("TossAuth.login")
    });
    await expect(identity.getAnonymousKey()).resolves.toEqual({ type: "HASH", hash: "hash-1" });
  });

  test("isSupported gates are preserved through the conversion", async () => {
    const base = officialModule();
    const appLogin = base.appLogin!;
    const unsupported = {
      appLogin: Object.assign(appLogin, { isSupported: () => false })
    };
    const identity = createReactNativeIdentity({ framework: adaptOfficialRnIdentity(unsupported) });

    await expect(identity.login()).rejects.toMatchObject({ code: "UNSUPPORTED" });
  });

  test("login results still pass through the shared validator", async () => {
    const official = officialModule({
      appLogin: () => Promise.resolve({ authorizationCode: "", referrer: "DEFAULT" })
    });
    const identity = createReactNativeIdentity({ framework: adaptOfficialRnIdentity(official) });

    await expect(identity.login()).rejects.toBeInstanceOf(SdkError);
    await expect(identity.login()).rejects.toMatchObject({ code: "INVALID_LOGIN_RESULT" });
  });
});

describe("RN official-module conversion (notification)", () => {
  test("forwards the params verbatim and preserves the returned cleanup", async () => {
    const official = officialModule();
    const notification = createReactNativeNotification({
      framework: adaptOfficialRnNotification(official)
    });

    const promise = notification.requestAgreement("TEMPLATE_9");
    await Bun.sleep(1);
    const { params, receiver } = official.calls.requestNotificationAgreement[0] as {
      params: {
        options: { templateCode: string };
        onEvent: (e: { type: string }) => void;
        onError: (error: unknown) => void;
      };
      receiver: string;
    };
    expect(params.options).toEqual({ templateCode: "TEMPLATE_9" });
    expect(typeof params.onEvent).toBe("function");
    expect(typeof params.onError).toBe("function");
    expect(receiver).toBe("official-module");

    params.onEvent({ type: "newAgreement" });
    await expect(promise).resolves.toMatchObject({ status: "agreed", templateCode: "TEMPLATE_9" });
    // The official cleanup function runs exactly once on settlement.
    expect(official.calls.cleanup).toEqual([true]);
  });

  test("a module without requestNotificationAgreement stays UNSUPPORTED", async () => {
    const notification = createReactNativeNotification({
      framework: adaptOfficialRnNotification({})
    });

    await expect(notification.requestAgreement("TEMPLATE_1")).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("Notification.requestAgreement")
    });
  });
});

describe("RN official-module conversion (share)", () => {
  test("getTossShareLink receives positional path/ogImageUrl arguments exactly once", async () => {
    const official = officialModule();
    const share = createReactNativeShare({ framework: adaptOfficialRnShare(official) });

    const link = await share.createLink("intoss://my-app");
    expect(link).toBe("https://toss.im/share/intoss://my-app");
    // Exactly one argument: no trailing undefined placeholder.
    expect(official.calls.getTossShareLink).toEqual([["intoss://my-app", "official-module"]]);

    await share.createLink("intoss://my-app", "https://cdn.example/og.png");
    expect(official.calls.getTossShareLink[1]).toEqual([
      "intoss://my-app",
      "https://cdn.example/og.png",
      "official-module"
    ]);
  });

  test("share receives the { message } object and maps completion to completed", async () => {
    const official = officialModule();
    const share = createReactNativeShare({ framework: adaptOfficialRnShare(official) });

    await expect(share.sendMessage("hello")).resolves.toEqual({ status: "completed" });
    expect(official.calls.share).toEqual([[{ message: "hello" }, "official-module"]]);
  });

  test("share rejections keep their code and reason", async () => {
    const official = officialModule({
      share: () => Promise.reject({ code: "SHEET_FAILED", message: "boom" })
    });
    const share = createReactNativeShare({ framework: adaptOfficialRnShare(official) });

    await expect(share.sendMessage("x")).resolves.toEqual({
      status: "failed",
      code: "SHEET_FAILED",
      reason: "boom"
    });
  });

  test("partial share surfaces work per operation", async () => {
    const official = { getTossShareLink: officialModule().getTossShareLink };
    const share = createReactNativeShare({ framework: adaptOfficialRnShare(official) });

    await expect(share.createLink("intoss://app")).resolves.toBe(
      "https://toss.im/share/intoss://app"
    );
    await expect(share.sendMessage("x")).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("Share.sendMessage")
    });
  });
});
