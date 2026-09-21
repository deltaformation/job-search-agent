"use client";

import { useEffect, useRef } from "react";
import { ExternalLink, SlidersHorizontal, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { JobDetailView } from "@/src/server/board";

interface PropertiesSheetProps {
  open: boolean;
  onClose: () => void;
  job: JobDetailView["job"];
  extraction?: JobDetailView["extraction"];
  attempts?: JobDetailView["attempts"];
  source?: JobDetailView["source"];
  approvedVersionLabel?: string | null;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export default function PropertiesSheet({
  open,
  onClose,
  job,
  extraction: _extraction,
  attempts = [],
  source,
  approvedVersionLabel,
  triggerRef,
}: PropertiesSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Focus trapping and escape dismiss (C3, C4)
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    const triggerEl = triggerRef?.current;
    // Focus the close button when opened
    const timer = setTimeout(() => closeButtonRef.current?.focus(), 50);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", handleKeyDown);
      // Restore focus to trigger when sheet closes
      triggerEl?.focus();
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  const displaySalary = job.salaryText ?? "Unknown";
  const displayLocation = job.location ?? "Unknown";
  const displayArrangement = job.arrangement ?? "Unknown";
  const displayDate = job.postedAt ?? job.createdAt ?? "Unknown";
  const sourceUrl = source?.canonicalUrl ?? null;

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
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label="Close properties sheet"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
          {/* Overview */}
          <div className="space-y-2.5 rounded-lg border border-border/60 bg-muted/20 p-3.5">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Overview
            </span>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Status</span>
              <Badge
                variant={job.status === "TAILORED" ? "default" : "secondary"}
                className={
                  job.status === "TAILORED"
                    ? "bg-emerald-600 text-white hover:bg-emerald-600"
                    : "bg-muted text-foreground"
                }
              >
                {job.status}
              </Badge>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Primary resume</span>
              <span className="font-medium text-foreground">
                {approvedVersionLabel ?? "None"}
              </span>
            </div>
          </div>

          {/* Job Details (C4 exact persisted values) */}
          <div className="space-y-2.5 rounded-lg border border-border/60 bg-muted/20 p-3.5">
            <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Posting Details
            </span>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Salary</span>
              <span className="font-medium text-foreground">{displaySalary}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Location</span>
              <span className="font-medium text-foreground">{displayLocation}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Arrangement</span>
              <span className="font-medium text-foreground">{displayArrangement}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Date</span>
              <span className="font-medium text-foreground">{displayDate}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">URL</span>
              {sourceUrl ? (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline max-w-[200px] truncate"
                  aria-label="Open original job posting"
                >
                  <span className="truncate">{sourceUrl}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              ) : (
                <span className="font-medium text-foreground">Unknown</span>
              )}
            </div>
          </div>

          {/* Source details (collapsed diagnostics per C4) */}
          <details className="rounded-lg border border-border/50 p-3.5">
            <summary className="cursor-pointer text-xs font-medium text-foreground">
              Source details
            </summary>
            <div className="mt-3 flex flex-col gap-2.5 text-[11px] font-mono text-muted-foreground">
              <div className="flex justify-between">
                <span>Job ID:</span>
                <span className="text-foreground select-all">{job.id}</span>
              </div>
              <div className="flex justify-between">
                <span>Scrape State:</span>
                <span className="text-foreground">{job.scrapeState}</span>
              </div>
              {job.scrapeReasonCode && (
                <div className="flex justify-between">
                  <span>Scrape Reason:</span>
                  <span className="text-foreground">{job.scrapeReasonCode}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>Tailoring State:</span>
                <span className="text-foreground">{job.tailoringState}</span>
              </div>
              <div className="flex justify-between">
                <span>Extraction ID:</span>
                <span className="text-foreground truncate max-w-[180px]">
                  {job.activeExtractionId ?? "None"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Row Version:</span>
                <span className="text-foreground">{job.rowVersion}</span>
              </div>
              <div className="flex justify-between">
                <span>Attempts:</span>
                <span className="text-foreground">{attempts.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Created:</span>
                <span className="text-foreground">{job.createdAt}</span>
              </div>
              <div className="flex justify-between">
                <span>Updated:</span>
                <span className="text-foreground">{job.updatedAt}</span>
              </div>
              {source && (
                <div className="mt-2 border-t border-border/40 pt-2">
                  <span className="font-semibold text-foreground">Source Artifact:</span>
                  <p className="mt-1 truncate">{source.canonicalUrl}</p>
                </div>
              )}
            </div>
          </details>

          {/* Original posting link button */}
          {sourceUrl && (
            <div className="border-t border-border/60 pt-3">
              <a
                href={sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 rounded-lg border border-border/80 bg-card p-2.5 text-xs font-medium text-foreground hover:bg-muted/40 transition-colors"
                aria-label="Open original job posting in new tab"
              >
                <span>Original posting</span>
                <ExternalLink className="size-3.5 text-muted-foreground" />
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
