"use client";

import { useState } from "react";
import type { BoardCardView } from "@/src/server/board";
import { errorMessage } from "../api";
import Dialog from "./dialog";
import { postJobMutation } from "./mutate";

/**
 * Ordinary rejection with its required reason. Rejecting cancels the
 * card's queued work; reopening later is an explicit correction.
 */

interface RejectDialogProps {
  card: BoardCardView;
  rank: number;
  onClose: () => void;
  onSaved: () => void;
}

export default function RejectDialog({ card, rank, onClose, onSaved }: RejectDialogProps) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(): Promise<void> {
    if (reason.trim() === "") {
      setError("Rejecting needs a reason.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await postJobMutation(`/api/jobs/${card.id}/move`, {
        to: "REJECTED",
        rank,
        observedRowVersion: card.rowVersion,
        reason: reason.trim(),
      });
      onSaved();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog labelledBy="reject-heading" onClose={onClose} position="center">
      <h2 id="reject-heading" className="text-xl font-semibold">
        Reject card
      </h2>
      <p className="mt-1 text-sm">
        {card.title ?? "Untitled posting"} — rejecting records a reason and
        cancels any queued work for this card.
      </p>
      <div className="mt-4">
        <label htmlFor="reject-reason" className="block font-semibold">
          Reason (required)
        </label>
        <input
          id="reject-reason"
          type="text"
          value={reason}
          maxLength={280}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. onsite-only, duplicate posting"
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
          {saving ? "Rejecting…" : "Reject card"}
        </button>
        <button type="button" onClick={onClose} className="border px-4 py-2">
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
