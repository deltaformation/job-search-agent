"use client";

import { useState } from "react";
import { XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface MockupDeclineModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDecline: (reason: string) => void;
}

export default function MockupDeclineModal({
  open,
  onOpenChange,
  onDecline,
}: MockupDeclineModalProps) {
  const [reason, setReason] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) return;
    onDecline(reason);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <XCircle className="size-5 text-rose-600 dark:text-rose-400" aria-hidden="true" />
            <DialogTitle className="text-base font-semibold">Decline version</DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            A reason is required. No new version will be generated.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2 text-xs">
          <div>
            <label htmlFor="decline-reason" className="font-semibold text-foreground">
              Reason
            </label>
            <textarea
              id="decline-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              required
              className="mt-1.5 w-full rounded-lg border border-border/70 bg-background p-2.5 text-xs text-foreground focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
              placeholder="e.g. Needs more emphasis on specific telemetry KPIs or decided not to apply..."
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
            <Button
              type="submit"
              size="sm"
              variant="destructive"
              className="font-semibold"
            >
              Decline version
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
