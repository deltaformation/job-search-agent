// @vitest-environment node
import { describe, expect, it } from "vitest";
import { detectBlock } from "../../../src/scraping/blocks";

const CLEAN = {
  httpStatus: 200,
  textSample: "senior engineer\nbuild things\napply now",
  htmlSample: "<html><body><h1>senior engineer</h1></body></html>",
  title: "senior engineer - example",
};

describe("block detection", () => {
  it("passes a clean posting page", () => {
    expect(detectBlock(CLEAN)).toEqual({ blocked: false });
  });

  it("treats refusal statuses as access denied", () => {
    for (const httpStatus of [401, 403, 407, 451]) {
      expect(detectBlock({ ...CLEAN, httpStatus })).toMatchObject({
        blocked: true,
        reasonCode: "ACCESS_DENIED",
      });
    }
  });

  it("detects captcha challenges by marker or mention", () => {
    expect(
      detectBlock({
        ...CLEAN,
        htmlSample: '<div class="g-recaptcha"></div>',
      }),
    ).toMatchObject({ blocked: true, reasonCode: "CAPTCHA_REQUIRED" });
    expect(
      detectBlock({
        ...CLEAN,
        textSample: "please solve the captcha to continue",
      }),
    ).toMatchObject({ blocked: true, reasonCode: "CAPTCHA_REQUIRED" });
    expect(
      detectBlock({
        ...CLEAN,
        htmlSample: '<iframe src="https://challenges.cloudflare.com/cf-chl"></iframe>',
      }),
    ).toMatchObject({ blocked: true, reasonCode: "CAPTCHA_REQUIRED" });
  });

  it("requires both a password field and a login demand for login blocks", () => {
    expect(
      detectBlock({
        ...CLEAN,
        htmlSample: '<form><input type="password" name="password"></form>',
        textSample: "sign in to continue reading this posting",
        title: "sign in",
      }),
    ).toMatchObject({ blocked: true, reasonCode: "LOGIN_REQUIRED" });
    // A stray password field without a login demand stays a success:
    // false blocks hide real postings.
    expect(
      detectBlock({
        ...CLEAN,
        htmlSample:
          '<form id="newsletter"><input type="password" name="x"></form>',
      }),
    ).toEqual({ blocked: false });
  });

  it("detects denied page text", () => {
    expect(
      detectBlock({ ...CLEAN, textSample: "access denied: bot suspected" }),
    ).toMatchObject({ blocked: true, reasonCode: "ACCESS_DENIED" });
  });

  it("does not false-positive on passive recaptcha keys, scripts, or body mentions", () => {
    // Ashby embeds recaptchaPublicSiteKey in page JSON and .grecaptcha-badge in CSS:
    expect(
      detectBlock({
        ...CLEAN,
        htmlSample:
          '<script>{"recaptchaPublicSiteKey":"6LeFb_YUAAAAALUD5h"}</script><style>.grecaptcha-badge{}</style>',
      }),
    ).toEqual({ blocked: false });

    // Descriptions mentioning captcha/bot defenses on real jobs:
    expect(
      detectBlock({
        ...CLEAN,
        textSample:
          "You will design anti-bot defenses, rate limiters, and captcha verification flows.",
      }),
    ).toEqual({ blocked: false });

    // Script tags for turnstile or recaptcha in <head> of a full posting:
    expect(
      detectBlock({
        httpStatus: 200,
        title: "Senior Product Manager - Voice at Jobber",
        textSample: "a".repeat(2000),
        htmlSample:
          '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>',
      }),
    ).toEqual({ blocked: false });
  });
});
