"use client";

import { RefreshCw, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface MockupConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  errorType: "spawn_failure" | "provider_timeout" | null;
  onSimulateRecovery: () => void;
}

export default function MockupConnectionDialog({
  open,
  onOpenChange,
  errorType,
  onSimulateRecovery,
}: MockupConnectionDialogProps) {
  const isSpawn = errorType === "spawn_failure";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Server className="size-5 text-primary" aria-hidden="true" />
            <DialogTitle className="text-base font-semibold">
              Connection check
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground">
            Simulated · No network requests
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2 text-xs">
          {/* Diagnostic Status Box */}
          <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground">Local Agent Process:</span>
              <Badge
                variant="outline"
                className={
                  isSpawn
                    ? "border-rose-500/40 text-rose-600 dark:text-rose-400"
                    : "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                }
              >
                {isSpawn ? "Failed to Spawn" : "Process Running"}
              </Badge>
            </div>
            <p className="mt-1.5 text-muted-foreground">
              {isSpawn
                ? "The local connection process could not start."
                : "Local process running. Provider response delayed."}
            </p>
          </div>

          <div className="space-y-2 rounded-lg border border-border/50 bg-card p-3 font-mono text-[11px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Loopback Binding:</span>
              <span className="text-emerald-600 dark:text-emerald-400">127.0.0.1:3000 (OK)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Process Sandbox:</span>
              <span className="text-foreground">Standard isolated mode</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Simulation status:</span>
              <span className="text-amber-600 dark:text-amber-400">Fictional test probe</span>
            </div>
          </div>



          {/* Action buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onSimulateRecovery();
              }}
              className="gap-1.5 font-semibold"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              <span>Retry sample</span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
