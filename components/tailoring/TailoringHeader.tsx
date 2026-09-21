"use client";

import Link from "next/link";
import { ArrowLeft, MessageSquare, SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface TailoringHeaderProps {
  jobTitle: string;
  company: string | null;
  pipelineStatus: string;
  activeVersionLabel?: string | null;
  notesCount: number;
  onOpenProperties: () => void;
  onOpenNotes: () => void;
  propertiesTriggerRef?: React.RefObject<HTMLButtonElement | null>;
  notesTriggerRef?: React.RefObject<HTMLButtonElement | null>;
}

export default function TailoringHeader({
  jobTitle,
  company,
  pipelineStatus,
  activeVersionLabel,
  notesCount,
  onOpenProperties,
  onOpenNotes,
  propertiesTriggerRef,
  notesTriggerRef,
}: TailoringHeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-8">
        {/* Left: Back link, Job Title, Company */}
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Back to board"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Board</span>
          </Link>

          <div className="h-4 w-px bg-border/60" aria-hidden="true" />

          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-tight text-foreground sm:text-lg">
              {jobTitle}
            </h1>
            <span className="text-sm font-medium text-muted-foreground">·</span>
            <span className="shrink-0 text-sm font-medium text-muted-foreground">
              {company ?? "Unknown Company"}
            </span>
          </div>
        </div>

        {/* Right: Status badge + Notes + Properties buttons */}
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-1.5">
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
            {activeVersionLabel && (
              <span className="hidden text-xs text-muted-foreground sm:inline">
                ({activeVersionLabel})
              </span>
            )}
          </div>

          <div className="h-4 w-px bg-border/60" aria-hidden="true" />

          {/* Notes Trigger */}
          <Button
            ref={notesTriggerRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenNotes}
            className="gap-1.5 text-xs font-medium cursor-pointer"
            aria-label="Open notes and timeline"
          >
            <MessageSquare className="size-3.5" aria-hidden="true" />
            <span>Notes</span>
            {notesCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] font-mono tabular-nums text-muted-foreground">
                {notesCount}
              </span>
            )}
          </Button>

          {/* Properties Trigger */}
          <Button
            ref={propertiesTriggerRef}
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenProperties}
            className="gap-1.5 text-xs font-medium cursor-pointer"
            aria-label="Open job properties sheet"
          >
            <SlidersHorizontal className="size-3.5" aria-hidden="true" />
            <span>Properties</span>
          </Button>
        </div>
      </div>
    </header>
  );
}
