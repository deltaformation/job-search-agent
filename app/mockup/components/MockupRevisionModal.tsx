"use client";

import { useState } from "react";
import { Edit3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface MockupRevisionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitRevision: (note: string) => void;
}

export default function MockupRevisionModal({
  open,
  onOpenChange,
  onSubmitRevision,
}: MockupRevisionModalProps) {
  const [note, setNote] = useState(
    "Emphasize cross-functional operational collaboration between engineering and logistics operations."
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!note.trim()) return;
    onSubmitRevision(note);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Edit3 className="size-5 text-primary" aria-hidden="true" />
            <DialogTitle className="text-base font-semibold">Request changes</DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            Your current focus carries into the next version.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2 text-xs">
          <div>
            <label htmlFor="revision-note" className="font-semibold text-foreground">
              What should change?
            </label>
            <textarea
              id="revision-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              required
              className="mt-1.5 w-full rounded-lg border border-border/70 bg-background p-2.5 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Explain what to adjust or emphasize..."
            />
          </div>



          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" className="font-semibold">
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
