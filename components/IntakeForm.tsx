"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
    <section aria-labelledby="intake-heading">
      <h1 id="intake-heading" className="text-2xl font-semibold">
        Add job URLs
      </h1>
      <p className="mt-2">
        Paste one public job posting URL per line. Validation checks each
        line before anything is queued.
      </p>
      {error !== null && (
        <p role="alert" className="mt-4 font-semibold">
          {error}
        </p>
      )}
      <form onSubmit={onPrepare} className="mt-4">
        <label htmlFor="intake-urls" className="font-semibold">
          Job posting URLs, one per line
        </label>
        <textarea
          id="intake-urls"
          className="mt-2 block w-full border p-2"
          rows={8}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={"https://example.com/jobs/123\nhttps://example.com/jobs/456"}
        />
        <p className="mt-1 text-sm">
          {nonBlank} {nonBlank === 1 ? "URL" : "URLs"} (at most 100).
        </p>
        <div className="mt-3 flex gap-3">
          <button
            type="submit"
            disabled={busy !== null || nonBlank === 0}
            className="border px-4 py-2 font-semibold disabled:opacity-50"
          >
            {busy === "preparing" ? "Validating…" : "Validate"}
          </button>
          {preview !== null && (
            <button
              type="button"
              onClick={onEnqueue}
              disabled={busy !== null}
              className="border px-4 py-2 font-semibold disabled:opacity-50"
            >
              {busy === "enqueuing" ? "Queueing…" : "Queue batch"}
            </button>
          )}
        </div>
      </form>
      {preview !== null && (
        <div className="mt-6">
          <h2 ref={previewHeadingRef} tabIndex={-1} className="text-xl font-semibold">
            Validation preview
          </h2>
          {preview.length === 0 ? (
            <p className="mt-2">Nothing to validate: every line is blank.</p>
          ) : (
            <table className="mt-2 w-full border-collapse border text-left">
              <thead>
                <tr>
                  <th scope="col" className="border p-2">Line</th>
                  <th scope="col" className="border p-2">URL</th>
                  <th scope="col" className="border p-2">Result</th>
                  <th scope="col" className="border p-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((line) => (
                  <tr key={line.lineNumber}>
                    <td className="border p-2">{line.lineNumber}</td>
                    <td className="break-all border p-2">{line.rawInput}</td>
                    <td className="border p-2">
                      <OutcomeLabel outcome={line.outcome} />
                    </td>
                    <td className="border p-2">
                      {line.reasonCode ?? ""}
                      {line.detail === null ? "" : ` — ${line.detail}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
