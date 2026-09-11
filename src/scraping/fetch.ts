import type { Request, Response, Route } from "playwright";
import type { ReasonCode } from "../domain/enums";
import { createLogger } from "../security/logger";
import { detectBlock } from "./blocks";
import { createIsolatedContext, type BrowserSupplier } from "./browser";
import { classifyRequestUrl, countRedirects, MAX_REDIRECTS } from "./guard";
import { preflightHost, type DnsResolver } from "./ssrf";
import { OriginThrottle } from "./throttle";

const log = createLogger("fetcher");

/**
 * Page fetch orchestrator: throttle → isolated context → guarded
 * navigation → block detection → bounded capture. One fetch maps to one
 * `PageFetch`, which the SCRAPE handler persists; no database access
 * happens here, so this module stays free of transactions by construction.
 *
 * Every request the page makes — navigation, redirect hops, subresources,
 * workers (blocked), popups (closed) — passes the route guard, which
 * revalidates DNS per request. A guard abort on the navigation request
 * fails the fetch with the guard's reason; subresource aborts only
 * degrade the page, never the outcome.
 */

export const NAVIGATION_TIMEOUT_MS = 30_000;
export const CAPTURE_TIMEOUT_MS = 15_000;
export const NETWORK_SETTLE_MS = 3000;
export const MAX_HTML_BYTES = 5_000_000;
export const MAX_TEXT_CHARS = 1_000_000;
export const MAX_JSONLD_BLOCKS = 50;
export const MAX_JSONLD_BLOCK_CHARS = 20_000;
export const TEXT_SIGNAL_CHARS = 8000;
export const HTML_SIGNAL_CHARS = 32_000;
export const MAX_DETAIL_CHARS = 2000;

export interface PageFetch {
  finalUrl: string;
  httpStatus: number | null;
  redirectChain: string[];
  outcome: "SUCCEEDED" | "BLOCKED" | "FAILED";
  reasonCode: ReasonCode | null;
  detail: string | null;
  title: string;
  html: Buffer | null;
  htmlMediaType: string | null;
  text: string | null;
  jsonLdBlocks: string[];
}

export interface FetchPageOptions {
  /** Exact submitted URL (user intent); canonical forms stay in the payload. */
  url: string;
  resolveHost?: DnsResolver;
  dnsTimeoutMs?: number;
  browser?: BrowserSupplier;
  /** Caller-owned throttle; the worker shares one across fetches. */
  throttle?: OriginThrottle;
  navigationTimeoutMs?: number;
}

interface GuardJournalEntry {
  url: string;
  navigation: boolean;
  reasonCode: ReasonCode;
  detail: string;
}

function truncateDetail(detail: string): string {
  return detail.length > MAX_DETAIL_CHARS
    ? detail.slice(0, MAX_DETAIL_CHARS)
    : detail;
}

function redirectChainUrls(finalRequest: Request): string[] {
  const chain: string[] = [];
  let current = finalRequest.redirectedFrom();
  while (current !== null && chain.length <= MAX_REDIRECTS + 1) {
    chain.unshift(current.url());
    current = current.redirectedFrom();
  }
  return chain;
}

function failedFetch(
  finalUrl: string,
  reasonCode: ReasonCode,
  detail: string,
  extra: Partial<PageFetch> = {},
): PageFetch {
  return {
    finalUrl,
    httpStatus: null,
    redirectChain: [],
    outcome: "FAILED",
    reasonCode,
    detail: truncateDetail(detail),
    title: "",
    html: null,
    htmlMediaType: null,
    text: null,
    jsonLdBlocks: [],
    ...extra,
  };
}

function blockedFetch(
  finalUrl: string,
  httpStatus: number | null,
  redirectChain: string[],
  reasonCode: ReasonCode,
  detail: string,
  title: string,
): PageFetch {
  return {
    finalUrl,
    httpStatus,
    redirectChain,
    outcome: "BLOCKED",
    reasonCode,
    detail: truncateDetail(detail),
    title,
    html: null,
    htmlMediaType: null,
    text: null,
    jsonLdBlocks: [],
  };
}

async function timed<T>(
  label: string,
  timeoutMs: number,
  task: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([task(), timeout]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

export async function fetchJobPage(
  options: FetchPageOptions,
): Promise<PageFetch> {
  const navigationTimeoutMs =
    options.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS;
  let origin: string;
  try {
    origin = new URL(options.url).origin;
  } catch {
    return failedFetch(options.url, "INVALID_URL", "submitted URL is not parseable");
  }
  if (options.throttle !== undefined) {
    await options.throttle.gate(origin);
  }
  const journal: GuardJournalEntry[] = [];
  const guardRoute = async (route: Route): Promise<void> => {
    const request = route.request();
    const depth = countRedirects(request);
    const verdict = classifyRequestUrl(request.url(), depth);
    if (!verdict.allow) {
      journal.push({
        url: request.url(),
        navigation: request.isNavigationRequest(),
        reasonCode: verdict.reasonCode,
        detail: verdict.detail,
      });
      await route.abort("aborted");
      return;
    }
    const hostname = verdict.hostname ?? "";
    const preflight = await preflightHost(hostname, {
      resolver: options.resolveHost,
      timeoutMs: options.dnsTimeoutMs,
    });
    if (!preflight.ok) {
      journal.push({
        url: request.url(),
        navigation: request.isNavigationRequest(),
        reasonCode: preflight.reasonCode,
        detail: preflight.detail,
      });
      await route.abort("aborted");
      return;
    }
    await route.fallback();
  };

  const isolated = await createIsolatedContext(options.browser).catch(
    (error: unknown) => {
      const detail =
        error instanceof Error ? error.message : String(error);
      log.error("browser context creation failed", { detail });
      return null;
    },
  );
  if (isolated === null) {
    return failedFetch(
      options.url,
      "TIMEOUT",
      "browser was unavailable for this fetch",
    );
  }
  try {
    await isolated.context.route("**/*", guardRoute);
    let response: Response | null;
    try {
      response = await timed(
        "navigation",
        navigationTimeoutMs,
        () =>
          isolated.page.goto(options.url, {
            waitUntil: "domcontentloaded",
            timeout: navigationTimeoutMs,
          }),
      );
    } catch (error: unknown) {
      const mainBlock = journal.findLast((entry) => entry.navigation);
      if (mainBlock !== undefined) {
        const outcome =
          mainBlock.reasonCode === "PRIVATE_NETWORK" ||
          mainBlock.reasonCode === "INVALID_URL"
            ? "FAILED"
            : "BLOCKED";
        return outcome === "BLOCKED"
          ? blockedFetch(
            options.url,
            null,
            [],
            mainBlock.reasonCode,
            `navigation guard stopped the fetch: ${mainBlock.detail}`,
            "",
          )
          : failedFetch(
            options.url,
            mainBlock.reasonCode,
            `navigation guard stopped the fetch: ${mainBlock.detail}`,
          );
      }
      const detail = error instanceof Error ? error.message : String(error);
      if (/download/i.test(detail)) {
        return failedFetch(
          options.url,
          "UNSUPPORTED_PAGE",
          `navigation triggered a download: ${detail}`,
        );
      }
      return failedFetch(
        options.url,
        "TIMEOUT",
        `navigation failed: ${detail}`,
      );
    }
    const finalUrl = isolated.page.url();
    const finalRequest = response?.request() ?? null;
    const redirectChain =
      finalRequest === null ? [] : redirectChainUrls(finalRequest);
    const httpStatus = response?.status() ?? null;

    if (response === null || httpStatus === null) {
      return failedFetch(
        finalUrl,
        "STALE_INPUT",
        "navigation produced no response",
        { redirectChain },
      );
    }
    if (httpStatus === 404 || httpStatus === 410) {
      return failedFetch(
        finalUrl,
        "STALE_INPUT",
        `posting is gone (HTTP ${httpStatus})`,
        { httpStatus, redirectChain },
      );
    }
    if (httpStatus === 429 || httpStatus >= 500) {
      return failedFetch(
        finalUrl,
        "TIMEOUT",
        `server refused with HTTP ${httpStatus}; retry may succeed`,
        { httpStatus, redirectChain },
      );
    }
    if (
      httpStatus === 401 ||
      httpStatus === 403 ||
      httpStatus === 407 ||
      httpStatus === 451
    ) {
      return blockedFetch(
        finalUrl,
        httpStatus,
        redirectChain,
        "ACCESS_DENIED",
        `server refused the page (HTTP ${httpStatus})`,
        "",
      );
    }
    if (httpStatus < 200 || httpStatus >= 400) {
      return failedFetch(
        finalUrl,
        "UNSUPPORTED_PAGE",
        `unexpected status HTTP ${httpStatus}`,
        { httpStatus, redirectChain },
      );
    }
    const contentType =
      (await response.headerValue("content-type")) ?? "";
    if (contentType !== "" && !contentType.toLowerCase().includes("html")) {
      return failedFetch(
        finalUrl,
        "UNSUPPORTED_PAGE",
        `refusing non-HTML content (${contentType.slice(0, 120)})`,
        { httpStatus, redirectChain },
      );
    }

    // Best-effort settle for client-rendered postings; the fetch proceeds
    // with whatever rendered when the budget runs out.
    await isolated.page
      .waitForLoadState("networkidle", { timeout: NETWORK_SETTLE_MS })
      .catch(() => undefined);

    const title = await isolated.page.title().catch(() => "");
    let html: Buffer;
    try {
      html = await timed("capture", CAPTURE_TIMEOUT_MS, () => response.body());
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return failedFetch(
        finalUrl,
        "TIMEOUT",
        `reading the response body failed: ${detail}`,
        { httpStatus, redirectChain },
      );
    }
    if (html.length > MAX_HTML_BYTES) {
      return failedFetch(
        finalUrl,
        "UNSUPPORTED_PAGE",
        `page exceeds the ${MAX_HTML_BYTES}-byte capture bound`,
        { httpStatus, redirectChain },
      );
    }
    const text = await timed("capture", CAPTURE_TIMEOUT_MS, () =>
      isolated.page.innerText("body").catch(() => ""),
    ).catch(() => "");
    const verdict = detectBlock({
      httpStatus,
      textSample: text.slice(0, TEXT_SIGNAL_CHARS),
      htmlSample: html.toString("utf8", 0, HTML_SIGNAL_CHARS),
      title,
    });
    if (verdict.blocked) {
      return blockedFetch(
        finalUrl,
        httpStatus,
        redirectChain,
        verdict.reasonCode,
        verdict.detail,
        title,
      );
    }
    const jsonLdBlocks = await isolated.page
      .$$eval(
        'script[type="application/ld+json"]',
        (elements, cap) =>
          elements
            .slice(0, cap.blocks)
            .map((element) =>
              (element.textContent ?? "").slice(0, cap.chars),
            )
            .filter((block) => block.trim() !== ""),
        { blocks: MAX_JSONLD_BLOCKS, chars: MAX_JSONLD_BLOCK_CHARS },
      )
      .catch(() => [] as string[]);
    return {
      finalUrl,
      httpStatus,
      redirectChain,
      outcome: "SUCCEEDED",
      reasonCode: null,
      detail: null,
      title,
      html,
      htmlMediaType:
        contentType === "" ? "text/html; charset=utf-8" : contentType,
      text: text.slice(0, MAX_TEXT_CHARS),
      jsonLdBlocks,
    };
  } finally {
    await isolated.close().catch(() => undefined);
  }
}
