"use client";

import { useEffect, useRef } from "react";
import {
  ExternalLink,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { JobFixture } from "../fixtures/jobDescription";

interface MockupPropertiesSheetProps {
  open: boolean;
  onClose: () => void;
  job: JobFixture;
  pipelineStatus: string;
  approvedVersionLabel: string | null;
}

export default function MockupPropertiesSheet({
  open,
  onClose,
  job,
  pipelineStatus,
  approvedVersionLabel,
}: MockupPropertiesSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Focus trapping and escape dismiss
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    // Focus the close button when opened
    setTimeout(() => closeButtonRef.current?.focus(), 50);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="properties-sheet-title"
      className="fixed inset-0 z-50 flex justify-end"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-xs transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Slide-over panel */}
      <div
        ref={sheetRef}
        className="relative z-50 flex h-full w-full flex-col border-l border-border/80 bg-background shadow-2xl transition-transform duration-200 ease-out sm:w-[420px]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-primary" aria-hidden="true" />
            <h2 id="properties-sheet-title" className="text-base font-semibold text-foreground">
              Properties
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Close properties sheet"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {/* 1. Overview */}
          <div className="space-y-2.5 rounded-lg border border-border/60 bg-muted/20 p-3.5">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
              Overview
            </span>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Status</span>
              <Badge
                variant={pipelineStatus === "TAILORED" ? "default" : "secondary"}
                className={
                  pipelineStatus === "TAILORED"
                    ? "bg-emerald-600 text-white hover:bg-emerald-600"
                    : "bg-muted text-foreground"
                }
              >
                {pipelineStatus}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Primary resume</span>
              <span className="font-medium text-foreground">
                {approvedVersionLabel ?? "None"}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Profile</span>
              <span className="font-medium text-foreground">
                Mouad Atfi (Product Leadership)
              </span>
            </div>
          </div>

          <details className="rounded-lg border border-border/50 p-3.5">
            <summary className="cursor-pointer text-xs font-medium">Source details <span className="text-muted-foreground">· Sample</span></summary>
            <div className="mt-4 flex flex-col gap-4">
          {/* 2. Intake */}
          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3.5">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
              Intake
            </span>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Batch</span>
              <a
                href="#batch-queue-69f3ccfd"
                onClick={(e) => e.preventDefault()}
                className="font-mono text-xs text-primary underline hover:text-primary/80 transition-colors"
                title="View batch in intake queue"
              >
                #batch-69f3ccfd
              </a>
            </div>
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Lease status:</span>
              <span className="font-mono text-emerald-600 dark:text-emerald-400">Completed</span>
            </div>
          </div>

          {/* 3. Fetch (1) */}
          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
                Fetch
              </span>
              <Badge variant="outline" className="font-mono text-[11px]">
                1 Attempt
              </Badge>
            </div>
            <div className="space-y-1 text-[11px]">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Result</span>
                <span className="font-mono text-emerald-600 dark:text-emerald-400">200 OK</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Latency</span>
                <span className="font-mono text-muted-foreground">842ms</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">TLS Handshake</span>
                <span className="font-mono text-muted-foreground">TLS 1.3 / Verified</span>
              </div>
            </div>
          </div>

          {/* 4. Evidence Files */}
          <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
                Evidence Files
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">3 files</span>
            </div>
            <ul className="space-y-2 font-mono text-[11px]" aria-label="Evidence files list">
              <li className="flex items-center justify-between rounded border border-border/40 bg-card p-2">
                <div className="flex flex-col">
                  <span className="font-medium text-foreground">lime-jd-scraped.html</span>
                  <span className="text-[10px] text-muted-foreground">SHA: 7d4a98...e12b</span>
                </div>
                <span className="text-muted-foreground">42.8 KB</span>
              </li>
              <li className="flex items-center justify-between rounded border border-border/40 bg-card p-2">
                <div className="flex flex-col">
                  <span className="font-medium text-foreground">ashby-metadata.json</span>
                  <span className="text-[10px] text-muted-foreground">SHA: 3b9cf8...880a</span>
                </div>
                <span className="text-muted-foreground">1.4 KB</span>
              </li>
              <li className="flex items-center justify-between rounded border border-border/40 bg-card p-2">
                <div className="flex flex-col">
                  <span className="font-medium text-foreground">page-screenshot.png</span>
                  <span className="text-[10px] text-muted-foreground">SHA: e82d77...914c</span>
                </div>
                <span className="text-muted-foreground">285 KB</span>
              </li>
            </ul>
          </div>

          </div></details>
          {/* 5. Link to Posting (external) */}
          <div className="border-t border-border/60 pt-3">
            <a
              href={job.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 rounded-lg border border-border/80 bg-card p-2.5 text-xs font-medium text-foreground hover:bg-muted/40 transition-colors"
            >
              <span>Original posting</span>
              <ExternalLink className="size-3.5 text-muted-foreground" />
            </a>

          </div>
        </div>
      </div>
    </div>
  );
}
