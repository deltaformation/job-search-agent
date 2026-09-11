// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  classifyRequestUrl,
  countRedirects,
  MAX_REDIRECTS,
} from "../../../src/scraping/guard";

interface RedirectNode {
  redirectedFrom(): RedirectNode | null;
}

function chain(depth: number): RedirectNode {
  let current: RedirectNode | null = null;
  for (let i = 0; i < depth; i += 1) {
    const previous: RedirectNode | null = current;
    current = { redirectedFrom: () => previous };
  }
  const head: RedirectNode | null = current;
  return { redirectedFrom: () => head };
}

describe("request guard classification", () => {
  it("allows public http(s) URLs and reports the hostname", () => {
    expect(classifyRequestUrl("https://example.com/jobs/1", 0)).toEqual({
      allow: true,
      hostname: "example.com",
    });
    expect(classifyRequestUrl("http://example.com/plain", 2)).toMatchObject({
      allow: true,
    });
  });

  it("rejects non-http schemes, credentials, and bad hostnames", () => {
    expect(classifyRequestUrl("ftp://example.com/x", 0)).toMatchObject({
      allow: false,
      reasonCode: "INVALID_URL",
    });
    expect(
      classifyRequestUrl("https://user:pass@example.com/", 0),
    ).toMatchObject({ allow: false, reasonCode: "INVALID_URL" });
    expect(classifyRequestUrl("https://bad_host!.example/", 0)).toMatchObject(
      { allow: false, reasonCode: "INVALID_URL" },
    );
    expect(classifyRequestUrl("not a url", 0)).toMatchObject({
      allow: false,
      reasonCode: "INVALID_URL",
    });
  });

  it("enforces the redirect budget", () => {
    expect(
      classifyRequestUrl("https://example.com/a", MAX_REDIRECTS),
    ).toMatchObject({ allow: true });
    expect(
      classifyRequestUrl("https://example.com/a", MAX_REDIRECTS + 1),
    ).toMatchObject({ allow: false, reasonCode: "INVALID_URL" });
    expect(classifyRequestUrl("https://example.com/a", -1)).toMatchObject({
      allow: false,
    });
  });

  it("counts redirect hops without recursion", () => {
    expect(countRedirects(chain(0))).toBe(0);
    expect(countRedirects(chain(3))).toBe(3);
    // Pathological chains are capped, never hung or overflowed.
    expect(countRedirects(chain(100))).toBeGreaterThan(MAX_REDIRECTS);
  });
});
