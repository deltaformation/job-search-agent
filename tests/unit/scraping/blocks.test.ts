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
});
