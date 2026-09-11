"use client";

import { useCallback, useEffect, useState } from "react";
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
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-labelledby="clipper-heading" className="mt-8">
      <h2 id="clipper-heading" className="text-xl font-semibold">
        1-click browser clipper
      </h2>
      <p className="mt-1">
        Clip the posting you are already viewing — past any login or CAPTCHA
        you cleared yourself. Only the page URL and rendered DOM are sent to
        this local app; no cookies or sessions are touched.
      </p>
      {error !== null && (
        <p role="alert" className="mt-2 font-semibold">
          Could not load clip setup: {error}
        </p>
      )}
      {error === null && (token === null || origin === "") && (
        <p className="mt-2">Loading clip setup…</p>
      )}
      {error === null && token !== null && origin !== "" && !tokenValid && (
        <p role="alert" className="mt-2 font-semibold">
          Clip setup returned an unexpected token shape; not rendering the
          bookmarklet.
        </p>
      )}
      {error === null && token !== null && origin !== "" && tokenValid && (
        <div className="mt-2">
          <p>
            <a
              ref={linkRef}
              href="#clip-to-job-tracker"
              className="border px-4 py-2 font-semibold"
              title="Drag this link to your bookmarks bar"
            >
              Clip to Job Tracker
            </a>
          </p>
          <p className="mt-2 text-sm">
            Drag the button to your bookmarks bar, then click it on any
            posting. Prefer an extension? Load{" "}
            <code>extensions/clipper/</code> unpacked in Chrome/Brave and
            paste this token into its options page:
          </p>
          <p className="mt-1 break-all">
            <code>{token}</code>{" "}
            <button type="button" onClick={() => void onCopy()} className="underline">
              Copy token
            </button>
          </p>
          {copied && (
            <p role="status" className="mt-1 text-sm">
              Copied.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
