"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { JobDetailView } from "@/src/server/board";

interface NotesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  notes: JobDetailView["notes"];
  history?: JobDetailView["history"];
  onNoteAdded?: () => void;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export default function NotesModal({
  open,
  onOpenChange,
  jobId,
  notes,
  history = [],
  onNoteAdded,
  triggerRef,
}: NotesModalProps) {
  const [newNoteText, setNewNoteText] = useState("");
  const [activeTab, setActiveTab] = useState<"notes" | "timeline">("notes");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Focus restore on close (C3)
  useEffect(() => {
    if (!open) {
      triggerRef?.current?.focus();
    }
  }, [open, triggerRef]);

  const handleSubmitNote = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newNoteText.trim();
    if (!trimmed || submitting) return;

    if (trimmed.length > 4000) {
      setError("Note cannot exceed 4000 characters.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`/api/jobs/${jobId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: trimmed }),
      });

      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(errData.error?.message ?? `Failed to add note: ${res.status}`);
      }

      setNewNoteText("");
      onNoteAdded?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save note");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="border-b border-border/60 pb-3">
          <div className="flex items-center justify-between pr-6">
            <div className="flex items-center gap-2">
              <MessageSquare className="size-4 text-primary" aria-hidden="true" />
              <DialogTitle className="text-base font-semibold">Notes & Timeline</DialogTitle>
            </div>
            <div className="inline-flex rounded-md border border-border/70 bg-muted/30 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setActiveTab("notes")}
                className={`rounded px-2 py-0.5 font-medium transition-colors cursor-pointer ${
                  activeTab === "notes"
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Notes ({notes.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("timeline")}
                className={`rounded px-2 py-0.5 font-medium transition-colors cursor-pointer ${
                  activeTab === "timeline"
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Timeline ({history.length})
              </button>
            </div>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            Session notes and activity timeline for this job.
          </DialogDescription>
        </DialogHeader>

        <div className="pt-2 text-xs">
          {activeTab === "notes" ? (
            <div className="space-y-4">
              {/* Add Note Form */}
              <form onSubmit={handleSubmitNote} className="space-y-2">
                <textarea
                  value={newNoteText}
                  onChange={(e) => setNewNoteText(e.target.value)}
                  rows={2}
                  maxLength={4000}
                  placeholder="Record an observation, question, or follow-up note..."
                  className="w-full rounded-lg border border-border/70 bg-background p-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                {error && <p className="text-xs text-destructive">{error}</p>}
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {newNoteText.length}/4000
                  </span>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!newNoteText.trim() || submitting}
                    className="gap-1.5 text-xs font-semibold cursor-pointer"
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    <span>{submitting ? "Adding..." : "Add Note"}</span>
                  </Button>
                </div>
              </form>

              {/* Notes List */}
              <div className="max-h-[300px] space-y-2 overflow-y-auto pr-1" role="feed" aria-label="Job notes list">
                {notes.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    No notes recorded yet.
                  </p>
                ) : (
                  notes.map((note) => (
                    <article
                      key={note.id}
                      className="rounded-lg border border-border/50 bg-muted/20 p-3 text-xs"
                    >
                      <div className="flex items-center justify-between text-muted-foreground font-mono text-[11px]">
                        <span className="font-sans font-semibold text-foreground">
                          Note
                        </span>
                        <span>{note.createdAt}</span>
                      </div>
                      <p className="mt-1.5 whitespace-pre-wrap leading-relaxed text-foreground">
                        {note.body}
                      </p>
                    </article>
                  ))
                )}
              </div>
            </div>
          ) : (
            /* Timeline Tab */
            <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1" role="feed" aria-label="Activity timeline">
              {history.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No timeline events recorded yet.
                </p>
              ) : (
                history.map((event) => (
                  <div key={event.id} className="relative flex items-start gap-3 pl-1">
                    <span className="mt-1 flex size-2 shrink-0 rounded-full bg-primary" />
                    <div className="min-w-0 flex-1 rounded-lg border border-border/50 bg-muted/20 p-2.5">
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold text-foreground text-xs">
                          {event.fromStatus ? `${event.fromStatus} → ${event.toStatus}` : event.toStatus}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {event.createdAt}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground font-mono">
                        Actor: {event.actor}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
