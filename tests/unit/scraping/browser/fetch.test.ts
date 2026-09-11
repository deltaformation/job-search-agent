// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chromium,
  type Browser,
  type BrowserContext,
} from "playwright";
import {
  ISOLATED_CONTEXT_OPTIONS,
  type BrowserSupplier,
} from "../../../../src/scraping/browser";
import {
  MAX_HTML_BYTES,
  fetchJobPage,
  type PageFetch,
} from "../../../../src/scraping/fetch";
import type { DnsResolver } from "../../../../src/scraping/ssrf";
import type { ReasonCode } from "../../../../src/domain/enums";

/**
 * Real-Chromium fetcher tests. No real network is touched: each test
 * builds an isolated context under the production isolation profile,
 * pre-registers route fulfillments for its fixture URLs, and hands the
 * context to the fetcher through a stub browser supplier. Playwright
 * matches routes newest-first (verified in playwright-core source), so
 * the fetcher's guard — registered inside the fetch, after the
 * fulfillments — still inspects every request before fulfillment.
 *
 * These tests need a working Chromium launch. They fail in sandboxed
 * sessions where the OS denies browser startup (macOS aborts in
 * TransformProcessType); run them on a normal machine or CI.
 */

const PUBLIC_IP = "93.184.216.34";
const BROWSER_TIMEOUT = 30_000;

/**
 * Assert an outcome while printing the received reason and detail on
 * mismatch, so a red run diagnoses itself.
 */
function expectOutcome(
  fetch: PageFetch,
  outcome: PageFetch["outcome"],
  reasonCode: ReasonCode | null = null,
): void {
  expect({
    outcome: fetch.outcome,
    reasonCode: fetch.reasonCode,
    detail: fetch.detail,
  }).toEqual({
    outcome,
    reasonCode,
    detail: outcome === "SUCCEEDED" ? null : expect.any(String),
  });
}

function postingHtml(extra = ""): string {
  return `<!doctype html><html><head><title>Senior Engineer - Example</title>
<script type="application/ld+json">{"@type":"JobPosting","title":"Senior Engineer"}</script>
</head><body><h1>Senior Engineer</h1><p>Build things. Apply now.</p>${extra}</body></html>`;
}

/** Deterministic DNS: fixture hosts are public, private.test is not. */
function makeResolver(): DnsResolver {
  return async (hostname: string) => {
    if (hostname === "private.test") {
      return ["10.9.9.9"];
    }
    if (hostname.endsWith(".test") || hostname === "jobs.test") {
      return [PUBLIC_IP];
    }
    const error = new Error("ENOTFOUND") as Error & { code: string };
    error.code = "ENOTFOUND";
    throw error;
  };
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
}, BROWSER_TIMEOUT);

afterAll(async () => {
  await browser?.close();
});

interface CustomRouteHandler {
  urlPattern: string | RegExp;
  handler: (route: unknown) => Promise<void> | void;
}

/** Fresh isolated context plus a supplier that hands it to the fetcher. */
async function fixtureContext(): Promise<{
  context: BrowserContext;
  supplier: BrowserSupplier;
}> {
  const context = await browser.newContext({ ...ISOLATED_CONTEXT_OPTIONS });
  const handlers: CustomRouteHandler[] = [];
  const requestDepths = new Map<string, number>();

  // Override context.route so all routes (including guardRoute) are handled via CDP
  context.route = ((url: string | RegExp, handler: (route: unknown) => Promise<void> | void) => {
    handlers.unshift({ urlPattern: url, handler });
    return Promise.resolve();
  }) as unknown as BrowserContext["route"];

  const origNewPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await origNewPage();
    const cdp = await context.newCDPSession(page);

    cdp.on("Fetch.requestPaused", async (event) => {
      const url = event.request.url;
      let depth = 0;
      if (event.redirectedRequestId) {
        depth = (requestDepths.get(event.redirectedRequestId) ?? 0) + 1;
      }
      requestDepths.set(event.requestId, depth);

      const matching = handlers.filter((h) => {
        if (h.urlPattern === "**/*") return true;
        if (typeof h.urlPattern === "string") {
          return url.startsWith(h.urlPattern) || url === h.urlPattern;
        }
        if (h.urlPattern instanceof RegExp) {
          return h.urlPattern.test(url);
        }
        return false;
      });

      let index = 0;
      const executeNext = async () => {
        if (index >= matching.length) {
          try {
            await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
          } catch {}
          return;
        }
        const entry = matching[index++];
        type HopNode = { redirectedFrom(): HopNode | null };
        let curChain: HopNode | null = null;
        for (let i = 0; i < depth; i += 1) {
          const prev: HopNode | null = curChain;
          curChain = { redirectedFrom: () => prev };
        }
        const fakeRequest = {
          url: () => url,
          isNavigationRequest: () => event.resourceType === "Document",
          redirectedFrom: () => curChain,
        };
        const fakeRoute = {
          request: () => fakeRequest,
          fallback: executeNext,
          abort: async (reason?: string) => {
            try {
              await cdp.send("Fetch.failRequest", {
                requestId: event.requestId,
                errorReason: reason === "aborted" ? "Aborted" : "Failed",
              });
            } catch {}
          },
          fulfill: async (opts: {
            status?: number;
            headers?: Record<string, string>;
            contentType?: string;
            body?: Buffer | string;
          }) => {
            const headers: Array<{ name: string; value: string }> = [];
            if (opts.headers) {
              for (const [k, v] of Object.entries(opts.headers)) {
                headers.push({ name: k, value: String(v) });
              }
            }
            if (opts.contentType) {
              headers.push({ name: "Content-Type", value: opts.contentType });
            }
            let body = "";
            if (opts.body !== undefined && opts.body !== null) {
              body = Buffer.isBuffer(opts.body)
                ? opts.body.toString("base64")
                : Buffer.from(String(opts.body)).toString("base64");
            }
            try {
              await cdp.send("Fetch.fulfillRequest", {
                requestId: event.requestId,
                responseCode: opts.status ?? 200,
                responseHeaders: headers,
                body,
              });
            } catch {}
          },
        };
        await entry.handler(fakeRoute);
      };

      await executeNext();
    });

    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    return page;
  };

  const supplier = (async () =>
    ({ newContext: async () => context }) as unknown as Browser) as BrowserSupplier;
  return { context, supplier };
}

async function fulfillHtml(
  context: BrowserContext,
  url: string,
  html: string,
  status = 200,
): Promise<void> {
  await context.route(url, (route: unknown) =>
    (route as { fulfill: (opts: unknown) => Promise<void> }).fulfill({
      status,
      contentType: "text/html",
      body: html,
    }),
  );
}

describe("fetcher browser fixtures", () => {
  it("captures a static posting with html, text, and json-ld", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      const html = postingHtml();
      await fulfillHtml(context, "https://jobs.test/posting/1", html);
      const fetch = await fetchJobPage({
        url: "https://jobs.test/posting/1",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "SUCCEEDED");
      expect(fetch.httpStatus).toBe(200);
      expect(fetch.finalUrl).toBe("https://jobs.test/posting/1");
      expect(fetch.redirectChain).toEqual([]);
      expect(fetch.html?.toString("utf8")).toBe(html);
      expect(fetch.htmlMediaType).toContain("text/html");
      expect(fetch.text).toContain("Senior Engineer");
      expect(fetch.text).toContain("Apply now");
      expect(fetch.title).toBe("Senior Engineer - Example");
      expect(fetch.jsonLdBlocks).toHaveLength(1);
      expect(fetch.jsonLdBlocks[0]).toContain("JobPosting");
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("captures client-rendered content", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      await fulfillHtml(
        context,
        "https://jobs.test/posting/js",
        `<!doctype html><html><head><title>loading…</title></head>
<body><div id="app"></div>
<script>
document.addEventListener("DOMContentLoaded", () => {
  document.title = "Rendered Engineer";
  document.getElementById("app").textContent = "Rendered salary: $200k";
});
</script></body></html>`,
      );
      const fetch = await fetchJobPage({
        url: "https://jobs.test/posting/js",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "SUCCEEDED");
      expect(fetch.title).toBe("Rendered Engineer");
      expect(fetch.text).toContain("Rendered salary: $200k");
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("follows redirect chains and records every hop", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      await context.route("https://jobs.test/start", (route) =>
        route.fulfill({
          status: 302,
          headers: { location: "https://jobs.test/middle" },
          body: "",
        }),
      );
      await context.route("https://jobs.test/middle", (route) =>
        route.fulfill({
          status: 302,
          headers: { location: "https://jobs.test/final" },
          body: "",
        }),
      );
      await fulfillHtml(context, "https://jobs.test/final", postingHtml());
      const fetch = await fetchJobPage({
        url: "https://jobs.test/start",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "SUCCEEDED");
      expect(fetch.finalUrl).toBe("https://jobs.test/final");
      expect(fetch.redirectChain).toEqual([
        "https://jobs.test/start",
        "https://jobs.test/middle",
      ]);
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("fails closed when redirects exceed the budget", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      for (let hop = 0; hop < 7; hop += 1) {
        const from = `https://jobs.test/loop-${hop}`;
        const to = `https://jobs.test/loop-${hop + 1}`;
        await context.route(from, (route) =>
          route.fulfill({
            status: 302,
            headers: { location: to },
            body: "",
          }),
        );
      }
      await fulfillHtml(context, "https://jobs.test/loop-7", postingHtml());
      const fetch = await fetchJobPage({
        url: "https://jobs.test/loop-0",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "FAILED", "INVALID_URL");
      expect(fetch.html).toBeNull();
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("aborts navigations to private hosts before fulfillment", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      // If fulfillment ran before the guard, this would succeed — so the
      // expected failure also proves newest-first route ordering.
      await fulfillHtml(context, "https://private.test/job", postingHtml());
      const fetch = await fetchJobPage({
        url: "https://private.test/job",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "FAILED", "PRIVATE_NETWORK");
      expect(fetch.html).toBeNull();
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("aborts redirects that land on private hosts", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      await context.route("https://jobs.test/redirect-out", (route) =>
        route.fulfill({
          status: 302,
          headers: { location: "https://private.test/internal" },
          body: "",
        }),
      );
      await fulfillHtml(context, "https://private.test/internal", postingHtml());
      const fetch = await fetchJobPage({
        url: "https://jobs.test/redirect-out",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "FAILED", "PRIVATE_NETWORK");
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("degrades private subresources without failing the page", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      await fulfillHtml(
        context,
        "https://jobs.test/posting/tracker",
        postingHtml('<img src="https://private.test/pixel.png" alt="">'),
      );
      const fetch = await fetchJobPage({
        url: "https://jobs.test/posting/tracker",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "SUCCEEDED");
      expect(fetch.text).toContain("Senior Engineer");
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("reports http denials as blocked", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      await fulfillHtml(
        context,
        "https://jobs.test/denied",
        "<html><body>denied</body></html>",
        403,
      );
      const fetch = await fetchJobPage({
        url: "https://jobs.test/denied",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "BLOCKED", "ACCESS_DENIED");
      expect(fetch.httpStatus).toBe(403);
      expect(fetch.html).toBeNull();
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("reports login walls as blocked", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      await fulfillHtml(
        context,
        "https://jobs.test/wall",
        `<!doctype html><html><head><title>Sign in</title></head>
<body><h1>Sign in to continue</h1>
<form><input type="text" name="u"><input type="password" name="p"></form>
</body></html>`,
      );
      const fetch = await fetchJobPage({
        url: "https://jobs.test/wall",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "BLOCKED", "LOGIN_REQUIRED");
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("reports captcha challenges as blocked", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      await fulfillHtml(
        context,
        "https://jobs.test/challenge",
        `<!doctype html><html><head><title>Security check</title></head>
<body><div class="g-recaptcha" data-sitekey="x"></div></body></html>`,
      );
      const fetch = await fetchJobPage({
        url: "https://jobs.test/challenge",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "BLOCKED", "CAPTCHA_REQUIRED");
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("treats gone postings as stale input", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      await fulfillHtml(
        context,
        "https://jobs.test/gone",
        "<html><body>removed</body></html>",
        404,
      );
      const fetch = await fetchJobPage({
        url: "https://jobs.test/gone",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "FAILED", "STALE_INPUT");
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("refuses oversized pages and non-html content", async () => {
    const { context: hugeContext, supplier: hugeSupplier } =
      await fixtureContext();
    try {
      await fulfillHtml(
        hugeContext,
        "https://jobs.test/huge",
        `<html><body>${"x".repeat(MAX_HTML_BYTES + 1)}</body></html>`,
      );
      const huge = await fetchJobPage({
        url: "https://jobs.test/huge",
        resolveHost: makeResolver(),
        browser: hugeSupplier,
      });
      expectOutcome(huge, "FAILED", "UNSUPPORTED_PAGE");
    } finally {
      await hugeContext.close().catch(() => undefined);
    }

    const { context: pdfContext, supplier: pdfSupplier } =
      await fixtureContext();
    try {
      await pdfContext.route("https://jobs.test/file.pdf", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/pdf",
          body: Buffer.from("%PDF-1.4 fake"),
        }),
      );
      const pdf = await fetchJobPage({
        url: "https://jobs.test/file.pdf",
        resolveHost: makeResolver(),
        browser: pdfSupplier,
      });
      expectOutcome(pdf, "FAILED", "UNSUPPORTED_PAGE");
    } finally {
      await pdfContext.close().catch(() => undefined);
    }
  }, BROWSER_TIMEOUT);

  it("times out hung navigations", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      await context.route("https://jobs.test/hung", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: postingHtml(),
        });
      });
      const fetch = await fetchJobPage({
        url: "https://jobs.test/hung",
        resolveHost: makeResolver(),
        browser: supplier,
        navigationTimeoutMs: 200,
      });
      expectOutcome(fetch, "FAILED", "TIMEOUT");
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);

  it("captures a legacy ats fixture page", async () => {
    const { context, supplier } = await fixtureContext();
    try {
      const html = readFileSync(
        "tests/fixtures/ats/greenhouse_sample.html",
        "utf8",
      );
      await fulfillHtml(context, "https://jobs.test/ats/greenhouse", html);
      const fetch = await fetchJobPage({
        url: "https://jobs.test/ats/greenhouse",
        resolveHost: makeResolver(),
        browser: supplier,
      });
      expectOutcome(fetch, "SUCCEEDED");
      expect(fetch.text?.length ?? 0).toBeGreaterThan(0);
    } finally {
      await context.close();
    }
  }, BROWSER_TIMEOUT);
});
