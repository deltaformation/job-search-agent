"use client";

import { useState } from "react";
import type { BoardCardView } from "@/src/server/board";
import { errorMessage } from "../api";
import Dialog from "./dialog";
import { postJobMutation } from "./mutate";

/**
 * Applied confirmation: the human records when they applied (defaulting to
 * now) plus an optional provider confirmation number. Both fields validate
 * client-side and the server re-validates; the timestamp is required.
 */

function nowLocalInput(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

interface AppliedModalProps {
  card: BoardCardView;
  rank: number;
  onClose: () => void;
  onSaved: () => void;
}

export default function AppliedModal({ card, rank, onClose, onSaved }: AppliedModalProps) {
  const [appliedAt, setAppliedAt] = useState(nowLocalInput);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(): Promise<void> {
    const parsed = new Date(appliedAt);
    if (appliedAt.trim() === "" || Number.isNaN(parsed.getTime())) {
      setError("Enter when you applied.");
      return;
    }
    if (confirmation.length > 128) {
      setError("Confirmation numbers hold at most 128 characters.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await postJobMutation(`/api/jobs/${card.id}/move`, {
        to: "APPLIED",
        rank,
        observedRowVersion: card.rowVersion,
        appliedAt: parsed.toISOString(),
        confirmationNumber: confirmation.trim() === "" ? undefined : confirmation.trim(),
      });
      onSaved();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog labelledBy="applied-heading" onClose={onClose} position="center">
      <h2 id="applied-heading" className="text-xl font-semibold">
        Record application
      </h2>
      <p className="mt-1 text-sm">
        {card.title ?? "Untitled posting"} — confirm you applied in the
        provider&apos;s system. This only records your action; the tracker
        never touches application forms.
      </p>
      <div className="mt-4">
        <label htmlFor="applied-at" className="block font-semibold">
          Applied at
        </label>
        <input
          id="applied-at"
          type="datetime-local"
          value={appliedAt}
          onChange={(event) => setAppliedAt(event.target.value)}
          className="mt-1 border p-2"
        />
      </div>
      <div className="mt-3">
        <label htmlFor="applied-confirmation" className="block font-semibold">
          Confirmation number <span className="font-normal">(optional)</span>
        </label>
        <input
          id="applied-confirmation"
          type="text"
          value={confirmation}
          maxLength={128}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder="e.g. req-2026-1184"
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
          {saving ? "Recording…" : "Record application"}
        </button>
        <button type="button" onClick={onClose} className="border px-4 py-2">
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
