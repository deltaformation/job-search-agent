"use client";

import { useState } from "react";
import { apiPost, errorMessage } from "../api";

/** Append one note to a card. Notes never move the card (and never conflict). */

interface AddNoteFormProps {
  jobId: string;
  onSaved: () => void;
}

export default function AddNoteForm({ jobId, onSaved }: AddNoteFormProps) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(): Promise<void> {
    if (body.trim() === "") {
      setError("Write the note first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/api/jobs/${jobId}/notes`, { body: body.trim() });
      setBody("");
      onSaved();
    } catch (submitError: unknown) {
      setError(errorMessage(submitError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3">
      <label htmlFor="add-note-body" className="block font-semibold">
        Add a note
      </label>
      <textarea
        id="add-note-body"
        rows={2}
        value={body}
        maxLength={4000}
        onChange={(event) => setBody(event.target.value)}
        className="mt-1 w-full border p-2"
      />
      {error !== null && (
        <p role="alert" className="mt-1 font-semibold">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={() => void onSubmit()}
        disabled={saving}
        className="mt-2 border px-4 py-2 font-semibold disabled:opacity-50"
      >
        {saving ? "Saving…" : "Add note"}
      </button>
    </div>
  );
}
