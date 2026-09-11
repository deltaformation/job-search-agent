"use client";

import { useState } from "react";
import type { BoardStatus } from "@/src/domain/enums";
import type { BoardCardView } from "@/src/server/board";
import { errorMessage } from "../api";
import Dialog from "./dialog";
import { postJobMutation } from "./mutate";

/**
 * Explicit correction/reopen: any target outside the ordinary graph, always
 * with a mandatory human note. TAILORED is never offered — only resume
 * approval moves a card there.
 */

const STATUSES: readonly BoardStatus[] = ["NEW", "TAILORED", "APPLIED", "INTERVIEWED", "REJECTED"];

interface CorrectDialogProps {
  card: BoardCardView;
  onClose: () => void;
  onSaved: () => void;
}

export default function CorrectDialog({ card, onClose, onSaved }: CorrectDialogProps) {
  const targets = STATUSES.filter((status) => status !== card.status && status !== "TAILORED");
  const [to, setTo] = useState<BoardStatus>(targets[0] as BoardStatus);
  const [note, setNote] = useState("");
  const [appliedAt, setAppliedAt] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(): Promise<void> {
    if (note.trim() === "") {
      setError("A correction needs a note explaining why.");
      return;
    }
    let appliedIso: string | undefined;
    if (to === "APPLIED") {
      const parsed = new Date(appliedAt);
      if (appliedAt.trim() === "" || Number.isNaN(parsed.getTime())) {
        setError("Correcting into Applied still needs the application timestamp.");
        return;
      }
      appliedIso = parsed.toISOString();
    }
    setSaving(true);
    setError(null);
    try {
      await postJobMutation(`/api/jobs/${card.id}/correct`, {
        to,
        rank: card.rank,
        observedRowVersion: card.rowVersion,
        note: note.trim(),
        appliedAt: appliedIso,
        confirmationNumber: confirmation.trim() === "" ? undefined : confirmation.trim(),
        reason: to === "REJECTED" && reason.trim() !== "" ? reason.trim() : undefined,
      });
      onSaved();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog labelledBy="correct-heading" onClose={onClose} position="center">
      <h2 id="correct-heading" className="text-xl font-semibold">
        Correct or reopen
      </h2>
      <p className="mt-1 text-sm">
        {card.title ?? "Untitled posting"} — currently {card.status}. Corrections
        are audited and mirror your note into the card&apos;s notes. Moving to
        Tailored requires resume approval, so it is not listed here.
      </p>
      <div className="mt-4">
        <label htmlFor="correct-target" className="block font-semibold">
          Move to
        </label>
        <select
          id="correct-target"
          value={to}
          onChange={(event) => setTo(event.target.value as BoardStatus)}
          className="mt-1 border bg-white p-2"
        >
          {targets.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>
      {to === "APPLIED" && (
        <div className="mt-3">
          <label htmlFor="correct-applied-at" className="block font-semibold">
            Applied at
          </label>
          <input
            id="correct-applied-at"
            type="datetime-local"
            value={appliedAt}
            onChange={(event) => setAppliedAt(event.target.value)}
            className="mt-1 border p-2"
          />
          <label htmlFor="correct-confirmation" className="mt-3 block font-semibold">
            Confirmation number <span className="font-normal">(optional)</span>
          </label>
          <input
            id="correct-confirmation"
            type="text"
            value={confirmation}
            maxLength={128}
            onChange={(event) => setConfirmation(event.target.value)}
            className="mt-1 w-full border p-2"
          />
        </div>
      )}
      {to === "REJECTED" && (
        <div className="mt-3">
          <label htmlFor="correct-reason" className="block font-semibold">
            Rejection reason <span className="font-normal">(optional — the note below is required)</span>
          </label>
          <input
            id="correct-reason"
            type="text"
            value={reason}
            maxLength={280}
            onChange={(event) => setReason(event.target.value)}
            className="mt-1 w-full border p-2"
          />
        </div>
      )}
      <div className="mt-3">
        <label htmlFor="correct-note" className="block font-semibold">
          Note (required)
        </label>
        <textarea
          id="correct-note"
          rows={3}
          value={note}
          maxLength={4000}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Why is this card moving?"
          className="mt-1 w-full border p-2"
        />
      </div>
      {error !== null && (
        <p role="alert" className="mt-3 font-semibold">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => void onSubmit()}
          disabled={saving}
          className="border px-4 py-2 font-semibold disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save correction"}
        </button>
        <button type="button" onClick={onClose} className="border px-4 py-2">
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
