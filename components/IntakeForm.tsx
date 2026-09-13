"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PreparedLine } from "@/src/server/intake";
import { apiPost, errorMessage } from "./api";
import { OutcomeLabel } from "./outcome-label";

/**
 * Paste → validate → enqueue. Validation previews exactly what the
 * server will classify (same code path); enqueueing re-sends the
 * current textarea so late edits are honored, then navigates to the
 * batch progress page.
 */
export default function IntakeForm() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"preparing" | "enqueuing" | null>(null);
  const [preview, setPreview] = useState<PreparedLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);

  // Focus lands after render: the heading only exists once preview state
  // commits, so focusing inside the submit handler would hit a null ref.
  useEffect(() => {
    if (preview !== null) {
      previewHeadingRef.current?.focus();
    }
  }, [preview]);

  async function onPrepare(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy("preparing");
    setError(null);
    try {
      const body = await apiPost<{ results: PreparedLine[] }>(
        "/api/intake/prepare",
        { lines: text.split("\n") },
      );
      setPreview(body.results);
    } catch (error: unknown) {
      setError(errorMessage(error));
      setPreview(null);
    } finally {
      setBusy(null);
    }
  }

  async function onEnqueue(): Promise<void> {
    setBusy("enqueuing");
    setError(null);
    try {
      const body = await apiPost<{ batchId: string }>("/api/intake/submit", {
        lines: text.split("\n"),
      });
      router.push(`/intake/batches/${body.batchId}`);
    } catch (error: unknown) {
      setError(errorMessage(error));
      setBusy(null);
    }
  }

  const nonBlank = text.split("\n").filter((line) => line.trim() !== "").length;

  return (
    <section
      aria-labelledby="intake-heading"
      className="rounded-xl border border-border/70 bg-card p-6 shadow-xs text-card-foreground"
    >
      <div className="border-b border-border/60 pb-4">
        <h1 id="intake-heading" className="text-2xl font-bold tracking-tight text-foreground">
          Add job URLs
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Paste one public job posting URL per line. Validation checks each
          line before anything is queued.
        </p>
      </div>

      {error !== null && (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 p-3.5 text-sm font-semibold text-destructive"
        >
          {error}
        </div>
      )}

      <form onSubmit={onPrepare} className="mt-5 space-y-4">
        <div>
          <label
            htmlFor="intake-urls"
            className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5"
          >
            Job posting URLs, one per line
          </label>
          <textarea
            id="intake-urls"
            className="block w-full rounded-lg border border-input bg-background p-3 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            rows={7}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={"https://example.com/jobs/123\nhttps://example.com/jobs/456"}
          />
          <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {nonBlank} {nonBlank === 1 ? "URL" : "URLs"} (at most 100).
            </span>
            <span>Lines separated by newline</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Button
            type="submit"
            disabled={busy !== null || nonBlank === 0}
            className="gap-2 font-medium"
          >
            <Sparkles className="h-4 w-4" />
            {busy === "preparing" ? "Validating…" : "Validate"}
          </Button>

          {preview !== null && (
            <Button
              type="button"
              onClick={onEnqueue}
              disabled={busy !== null}
              className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium shadow-xs"
            >
              <CheckCircle2 className="h-4 w-4" />
              {busy === "enqueuing" ? "Queueing…" : "Queue batch"}
              <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          )}
        </div>
      </form>

      {preview !== null && (
        <div className="workspace-tab mt-8 scroll-mt-24 border-t border-border/60 pt-6">
          <div className="flex items-center justify-between mb-3">
            <h2
              ref={previewHeadingRef}
              tabIndex={-1}
              className="text-lg font-bold tracking-tight text-foreground focus:outline-none"
            >
              Validation preview
            </h2>
            <span className="text-xs text-muted-foreground">
              {preview.length} {preview.length === 1 ? "item" : "items"} validated
            </span>
          </div>

          {preview.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing to validate: every line is blank.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border/80">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-muted/50 text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border/80">
                  <tr>
                    <th scope="col" className="p-3 w-16 text-center">Line</th>
                    <th scope="col" className="p-3">URL</th>
                    <th scope="col" className="p-3 w-28">Result</th>
                    <th scope="col" className="p-3">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {preview.map((line) => (
                    <tr key={line.lineNumber} className="hover:bg-muted/30 transition-colors">
                      <td className="p-3 text-center text-xs font-mono text-muted-foreground">
                        {line.lineNumber}
                      </td>
                      <td className="p-3 break-all font-mono text-xs text-foreground">
                        {line.rawInput}
                      </td>
                      <td className="p-3">
                        <OutcomeLabel outcome={line.outcome} />
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {line.reasonCode ?? ""}
                        {line.detail === null ? "" : ` — ${line.detail}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
