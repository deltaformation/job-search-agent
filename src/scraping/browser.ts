import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright";

/**
 * Browser lifecycle for the R2-C fetcher. One shared Chromium instance
 * per worker process; every fetch gets a fresh isolated context that is
 * closed in a `finally`, which satisfies the work-order isolation rule
 * without paying a browser launch per job.
 *
 * The launch is stock headless Chromium with no stealth behavior: the
 * default user agent (which honestly identifies headless Chrome), no
 * proxy/session reuse, strict HTTPS (certificate errors fail the fetch),
 * service workers blocked, downloads disabled, and popups closed on sight.
 */

export interface IsolatedFetchContext {
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export type BrowserSupplier = () => Promise<Browser>;

/**
 * Isolation profile for every fetch context, exported so browser tests
 * build fixtures under the identical profile (never a weaker one).
 */
export const ISOLATED_CONTEXT_OPTIONS: BrowserContextOptions = {
  serviceWorkers: "block",
  acceptDownloads: false,
  ignoreHTTPSErrors: false,
  javaScriptEnabled: true,
  bypassCSP: false,
  permissions: [],
  viewport: { width: 1280, height: 800 },
};

let sharedBrowser: Browser | null = null;
let launchInFlight: Promise<Browser> | null = null;

/**
 * Launch (once) or reuse the worker's Chromium instance. A dead or
 * disconnected browser is replaced on the next call, so a browser crash
 * fails at most the in-flight fetch.
 */
export async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser !== null && sharedBrowser.isConnected()) {
    return sharedBrowser;
  }
  if (launchInFlight === null) {
    launchInFlight = chromium
      .launch({ headless: true })
      .finally(() => {
        launchInFlight = null;
      });
  }
  sharedBrowser = await launchInFlight;
  return sharedBrowser;
}

/** Best-effort shutdown for worker exit; safe to call when never launched. */
export async function closeSharedBrowser(): Promise<void> {
  const browser = sharedBrowser;
  sharedBrowser = null;
  if (browser !== null && browser.isConnected()) {
    await browser.close();
  }
}

/**
 * Open one isolated context plus its first page. The caller must `await
 * close()` in a `finally` — contexts hold a browser profile slot each.
 */
export async function createIsolatedContext(
  supplier: BrowserSupplier = getSharedBrowser,
): Promise<IsolatedFetchContext> {
  const browser = await supplier();
  const context = await browser.newContext({ ...ISOLATED_CONTEXT_OPTIONS });
  const page = await context.newPage();
  context.on("page", (popup) => {
    if (popup !== page) {
      void popup.close().catch(() => undefined);
    }
  });
  return {
    context,
    page,
    close: () => context.close(),
  };
}
