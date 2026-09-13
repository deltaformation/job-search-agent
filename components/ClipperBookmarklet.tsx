"use client";

import { useCallback, useEffect, useState } from "react";
import { Bookmark, Check, Copy, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiGet, errorMessage } from "./api";

/**
 * 1-click clip setup: shows the personalized draggable bookmarklet (the
 * bearer token is embedded so captures from any job board authenticate)
 * and the token to paste into the unpackaged extension's options page.
 */

export function buildBookmarklet(baseUrl: string, token: string): string {
  const endpoint = JSON.stringify(`${baseUrl}/api/intake/clip`);
  const code =
    `fetch(${endpoint},{method:"POST",` +
    `headers:{"Content-Type":"application/json",` +
    `"Authorization":"Bearer ${token}"},` +
    `body:JSON.stringify({url:location.href,title:document.title,` +
    `html:document.documentElement.outerHTML,` +
    `selectedText:(getSelection()?.toString()||"").slice(0,20000)})})` +
    `.then(r=>r.json().then(j=>{` +
    `const m=j.outcome==="created"?"Clipped to a NEW job card":` +
    `j.outcome==="duplicate"?"Already tracked":` +
    `"Clip rejected: "+(j.detail||j.reasonCode||"unknown");alert(m)}),` +
    `e=>alert("Clip failed: "+e)).catch(e=>alert("Clip failed: "+e))`;
  return `javascript:${encodeURI(code)}`;
}

export default function ClipperBookmarklet() {
  const [token, setToken] = useState<string | null>(null);
  const [origin] = useState(() =>
    typeof window === "undefined" ? "" : window.location.origin,
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiGet<{ token: string }>("/api/intake/clip-token")
      .then((data) => {
        if (!cancelled) {
          setToken(data.token);
        }
      })
      .catch((fetchError: unknown) => {
        if (!cancelled) {
          setError(errorMessage(fetchError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tokenValid = token !== null && /^[0-9a-f]{64}$/.test(token);

  const linkRef = useCallback(
    (element: HTMLAnchorElement | null) => {
      // React sanitizes javascript: URLs set through props, which would
      // neuter the draggable bookmarklet; set the locally-generated href
      // on the DOM node directly. Both interpolated values are
      // constrained (the origin is JSON-quoted by the builder, the token
      // is validated hex), so no page content can break out of the script.
      if (element !== null && tokenValid && token !== null && origin !== "") {
        element.setAttribute("href", buildBookmarklet(origin, token));
      }
    },
    [tokenValid, token, origin],
  );

  async function onCopy(): Promise<void> {
    if (token === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      aria-labelledby="clipper-heading"
      className="rounded-xl border border-border/70 bg-card p-6 shadow-xs text-card-foreground"
    >
      <div className="border-b border-border/60 pb-4">
        <h2 id="clipper-heading" className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
          <Bookmark className="h-5 w-5 text-primary" />
          <span>1-click browser clipper</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Clip the posting you are already viewing — past any login or CAPTCHA
          you cleared yourself. Only the page URL and rendered DOM are sent to
          this local app; no cookies or sessions are touched.
        </p>
      </div>

      {error !== null && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 p-3.5 text-sm font-semibold text-destructive"
        >
          Could not load clip setup: {error}
        </div>
      )}

      {error === null && (token === null || origin === "") && (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Sparkles className="h-4 w-4 animate-spin text-primary" />
          <span>Loading clip setup…</span>
        </div>
      )}

      {error === null && token !== null && origin !== "" && !tokenValid && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 p-3.5 text-sm font-semibold text-destructive"
        >
          Clip setup returned an unexpected token shape; not rendering the
          bookmarklet.
        </div>
      )}

      {error === null && token !== null && origin !== "" && tokenValid && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <a
              ref={linkRef}
              href="#clip-to-job-tracker"
              onClick={(event) => {
                // Drag-only control: activating it in place would clip
                // this app page itself (a junk intake item) or jump to a
                // dead hash. Dragging to the bookmarks bar still works.
                event.preventDefault();
              }}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-bold text-primary shadow-xs hover:bg-primary/20 transition-colors cursor-grab active:cursor-grabbing w-fit"
              title="Drag this link to your bookmarks bar"
            >
              <Bookmark className="h-4 w-4" />
              Clip to Job Tracker
            </a>
            <span className="text-xs text-muted-foreground">
              ← Drag this button into your browser bookmarks bar
            </span>
          </div>

          <details className="rounded-lg border border-border/70 bg-muted/20 p-4">
            <summary className="cursor-pointer text-xs font-semibold text-muted-foreground hover:text-foreground">
              Browser extension setup (optional)
            </summary>
            <div className="mt-3 space-y-2">
              <p className="text-xs text-muted-foreground leading-relaxed">
                If using the unpackaged extension from{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold text-foreground">
                  extensions/clipper/
                </code>
                , paste this authentication token into its options page:
              </p>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-md border border-input bg-background p-2.5">
                <code className="font-mono text-xs text-muted-foreground break-all select-all">
                  {token}
                </code>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void onCopy()}
                    className="h-8 gap-1.5 text-xs font-medium"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3.5 w-3.5 text-emerald-600" />
                        <span>Copied!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" />
                        <span>Copy token</span>
                      </>
                    )}
                  </Button>
                  {copied && (
                    <p
                      role="status"
                      className="text-xs font-semibold text-emerald-600 dark:text-emerald-400"
                    >
                      Copied.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}
