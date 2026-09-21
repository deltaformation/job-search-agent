"use client";

import { useState } from "react";
import { MessageSquare, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface MockupNote {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  title: string;
  detail: string;
  timestamp: string;
  badge?: string;
}

interface MockupNotesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notes: MockupNote[];
  timeline: TimelineEvent[];
  onAddNote: (text: string) => void;
}

export default function MockupNotesModal({
  open,
  onOpenChange,
  notes,
  timeline,
  onAddNote,
}: MockupNotesModalProps) {
  const [newNoteText, setNewNoteText] = useState("");
  const [activeTab, setActiveTab] = useState<"notes" | "timeline">("notes");

  const handleSubmitNote = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNoteText.trim()) return;
    onAddNote(newNoteText.trim());
    setNewNoteText("");
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
                    ? "bg-background text-foreground "
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
                    ? "bg-background text-foreground "
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Timeline ({timeline.length})
              </button>
            </div>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            Session notes and activity.
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
                  placeholder="Record an observation, question, or follow-up note..."
                  className="w-full rounded-lg border border-border/70 bg-background p-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!newNoteText.trim()}
                    className="gap-1.5 text-xs font-semibold"
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    <span>Add Note</span>
                  </Button>
                </div>
              </form>

              {/* Notes List */}
              <div className="max-h-[300px] space-y-2 overflow-y-auto pr-1">
                {notes.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    No notes yet.
                  </p>
                ) : (
                  notes.map((note) => (
                    <div
                      key={note.id}
                      className="rounded-lg border border-border/50 bg-muted/20 p-3 text-xs"
                    >
                      <div className="flex items-center justify-between text-muted-foreground font-mono text-[11px]">
                        <span className="font-sans font-semibold text-foreground">
                          {note.author}
                        </span>
                        <span>{note.createdAt}</span>
                      </div>
                      <p className="mt-1.5 whitespace-pre-wrap leading-relaxed text-foreground">
                        {note.text}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            /* Timeline Tab */
            <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1">
              {timeline.map((event) => (
                <div key={event.id} className="relative flex items-start gap-3 pl-1">
                  <span className="mt-1 flex size-2 shrink-0 rounded-full bg-primary" />
                  <div className="min-w-0 flex-1 rounded-lg border border-border/50 bg-muted/20 p-2.5">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-semibold text-foreground text-xs">
                        {event.title}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {event.timestamp}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{event.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
