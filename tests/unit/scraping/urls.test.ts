// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  detectAtsType,
  isAtsUrl,
  MAX_URL_LENGTH,
  sanitizeDestinationUrl,
  type CanonicalUrl,
} from "../../../src/scraping";

function mustCanonicalize(raw: string): CanonicalUrl {
  const result = canonicalizeUrl(raw);
  if (!result.ok) {
    throw new Error(`expected valid URL: ${raw} (${result.detail})`);
  }
  return result.value;
}

describe("URL canonicalization (ported legacy cases)", () => {
  it("strips tracking params from Indeed links", () => {
    // Ported from test_clean_url_strips_tracking (case 1).
    const value = mustCanonicalize(
      "https://ca.indeed.com/viewjob?jk=12345abcdef&utm_source=mailer&utm_campaign=daily",
    );
    expect(value.canonicalUrl).toBe(
      "https://ca.indeed.com/viewjob?jk=12345abcdef",
    );
    expect(value.canonicalKey).toBe("ats:indeed:12345abcdef");
  });

  it("reduces LinkedIn job links to their posting id", () => {
    // Ported from test_clean_url_strips_tracking (case 2). Legacy rewrote
    // the whole URL to the ID path; the port keeps the normalized URL for
    // evidence and reduces only the dedupe key.
    const value = mustCanonicalize(
      "https://www.linkedin.com/jobs/view/9988776655/?trackingId=abc&refId=def",
    );
    expect(value.canonicalUrl).toBe(
      "https://www.linkedin.com/jobs/view/9988776655?refId=def",
    );
    expect(value.canonicalKey).toBe("ats:linkedin:9988776655");
  });

  it("detects ATS boards without substring false positives", () => {
    // Ported from test_ats_detection; matching fixed to exact-or-subdomain.
    expect(
      isAtsUrl(mustCanonicalize("https://jobs.lever.co/company/job123")),
    ).toBe(true);
    expect(
      detectAtsType(mustCanonicalize("https://boards.greenhouse.io/corp/123")),
    ).toBe("Greenhouse");
    expect(
      isAtsUrl(mustCanonicalize("https://example.com/careers")),
    ).toBe(false);
    expect(
      isAtsUrl(mustCanonicalize("https://fakegreenhouse.io/steal")),
    ).toBe(false);
    expect(
      isAtsUrl(mustCanonicalize("https://greenhouse.io.evil.com/x")),
    ).toBe(false);
  });
});

describe("URL validation policy", () => {
  it("accepts http and https and preserves the scheme in the key", () => {
    const secure = mustCanonicalize("https://example.com/jobs/1");
    expect(secure.scheme).toBe("https");
    const plain = mustCanonicalize("http://example.com/jobs/1");
    expect(plain.scheme).toBe("http");
    expect(secure.canonicalKey).not.toBe(plain.canonicalKey);
  });

  it("rejects credentials, schemes, and malformed input", () => {
    for (const [raw, detail] of [
      ["ftp://example.com/jobs", "only http and https"],
      ["file:///etc/passwd", "only http and https"],
      ["javascript:alert(1)", "only http and https"],
      ["https://user@example.com/", "credentials"],
      ["https://user:pass@example.com/", "credentials"],
      ["example.com/jobs", "absolute URL"],
      ["", "empty URL"],
      ["   ", "empty URL"],
      ["https://exa mple.com/", "parseable"],
      ["https://[::1", "parseable"],
    ] as const) {
      const result = canonicalizeUrl(raw);
      expect(result.ok, raw).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("INVALID_URL");
        expect(result.detail).toContain(detail);
      }
    }
    expect(canonicalizeUrl(`https://example.com/${"a".repeat(MAX_URL_LENGTH)}`).ok).toBe(
      false,
    );
  });

  it("rejects invalid hostnames", () => {
    expect(canonicalizeUrl("https://-bad-.com/").ok).toBe(false);
    expect(canonicalizeUrl(`https://${"a".repeat(64)}.com/`).ok).toBe(false);
    expect(canonicalizeUrl("http://localhost:3000/x").ok).toBe(true);
  });

  it("normalizes host case, ports, and trailing dots", () => {
    expect(mustCanonicalize("https://EXAMPLE.com/Jobs").hostname).toBe(
      "example.com",
    );
    expect(mustCanonicalize("http://example.com:80/x").canonicalUrl).toBe(
      "http://example.com/x",
    );
    expect(mustCanonicalize("https://example.com:443/x").canonicalUrl).toBe(
      "https://example.com/x",
    );
    expect(mustCanonicalize("http://example.com:8080/x").canonicalUrl).toBe(
      "http://example.com:8080/x",
    );
    expect(mustCanonicalize("http://example.com./x").hostname).toBe(
      "example.com",
    );
  });

  it("trims trailing slashes, drops fragments, and keeps path case", () => {
    expect(mustCanonicalize("https://example.com/jobs/").canonicalUrl).toBe(
      "https://example.com/jobs",
    );
    expect(mustCanonicalize("https://example.com/").canonicalUrl).toBe(
      "https://example.com",
    );
    expect(
      mustCanonicalize("https://example.com/Jobs/1#apply-now").canonicalUrl,
    ).toBe("https://example.com/Jobs/1");
    expect(mustCanonicalize("https://example.com/a/../b").canonicalUrl).toBe(
      "https://example.com/b",
    );
  });

  it("strips tracking params case-insensitively and sorts the rest", () => {
    expect(
      mustCanonicalize("https://example.com/j?b=2&utm_source=x&a=1#frag")
        .canonicalUrl,
    ).toBe("https://example.com/j?a=1&b=2");
    expect(
      mustCanonicalize("https://example.com/j?UTM_MEDIUM=x&ok=1").canonicalUrl,
    ).toBe("https://example.com/j?ok=1");
    // Legacy compared a lowercased name against mixed-case list entries, so
    // these were never stripped; the port strips them for real.
    expect(
      mustCanonicalize("https://example.com/j?spJobID=1&spPostingID=2&ok=3")
        .canonicalUrl,
    ).toBe("https://example.com/j?ok=3");
    expect(
      mustCanonicalize("https://example.com/j?tag=a&tag=b").canonicalUrl,
    ).toBe("https://example.com/j?tag=a&tag=b");
  });

  it("keeps ID-bearing params that look generic", () => {
    // `refId` is not on the legacy tracking list; only the LinkedIn key
    // reduction ignores it.
    expect(
      mustCanonicalize("https://example.com/j?refId=42").canonicalUrl,
    ).toBe("https://example.com/j?refId=42");
  });

  it("dedupes Indeed postings across regional hosts by jk", () => {
    const ca = mustCanonicalize("https://ca.indeed.com/viewjob?jk=ABC123&x=1");
    const com = mustCanonicalize("https://www.indeed.com/page?jk=ABC123");
    expect(ca.canonicalKey).toBe("ats:indeed:ABC123");
    expect(com.canonicalKey).toBe("ats:indeed:ABC123");
    // Without jk there is no stable id: plain URL key, host preserved.
    const noJk = mustCanonicalize("https://ca.indeed.com/jobs?q=cook");
    expect(noJk.canonicalKey).toBe(`url:${noJk.canonicalUrl}`);
    expect(noJk.canonicalUrl).toContain("ca.indeed.com");
  });

  it("dedupes LinkedIn postings by path id or currentJobId", () => {
    const path = mustCanonicalize("https://www.linkedin.com/jobs/view/123?x=1");
    const param = mustCanonicalize(
      "https://www.linkedin.com/jobs/search?currentJobId=123",
    );
    expect(path.canonicalKey).toBe("ats:linkedin:123");
    expect(param.canonicalKey).toBe("ats:linkedin:123");
    const other = mustCanonicalize("https://www.linkedin.com/jobs/search?x=1");
    expect(other.canonicalKey).toBe(`url:${other.canonicalUrl}`);
  });

  it("handles IP literals and internationalized domains", () => {
    const v4 = mustCanonicalize("http://93.184.216.34/jobs");
    expect(v4.hostname).toBe("93.184.216.34");
    const v6 = mustCanonicalize("http://[::1]:8080/x");
    expect(v6.hostname).toBe("::1");
    expect(v6.canonicalUrl).toBe("http://[::1]:8080/x");
    const idn = mustCanonicalize("http://münchen.de/");
    expect(idn.hostname).toBe("xn--mnchen-3ya.de");
  });

  it("trims surrounding whitespace but preserves the original", () => {
    const value = mustCanonicalize("  https://example.com/j?a=1  \n");
    expect(value.submittedUrl).toBe("https://example.com/j?a=1");
  });
});

describe("sanitizeDestinationUrl", () => {
  it("preserves trailing slash in pathname with query parameters", () => {
    const url = new URL(
      "https://www.kaseya.com/careers/jobs/id/6179651004/?gh_jid=6179651004#app",
    );
    expect(sanitizeDestinationUrl(url)).toBe(
      "https://www.kaseya.com/careers/jobs/id/6179651004/?gh_jid=6179651004",
    );
  });

  it("preserves trailing slash on paths without query parameters", () => {
    const url = new URL("https://example.com/apply/");
    expect(sanitizeDestinationUrl(url)).toBe("https://example.com/apply/");
  });

  it("preserves paths without trailing slash", () => {
    const url = new URL("https://example.com/apply");
    expect(sanitizeDestinationUrl(url)).toBe("https://example.com/apply");
  });

  it("strips tracking parameters and drops fragments", () => {
    const url = new URL(
      "https://example.com/apply/?utm_source=twitter&ref=social#form",
    );
    expect(sanitizeDestinationUrl(url)).toBe("https://example.com/apply/");
  });
});
