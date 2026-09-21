"use client";

import { SlidersHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface MockupHeaderProps {
  jobTitle: string;
  company: string;
  pipelineStatus: "NEW" | "TAILORED" | "APPLIED" | "REJECTED";
  activeVersionLabel?: string;
  onOpenProperties: () => void;
}

export default function MockupHeader({
  jobTitle,
  company,
  pipelineStatus,
  activeVersionLabel,
  onOpenProperties,
}: MockupHeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex max-w-[1440px] items-center gap-2 px-4 pt-3 text-xs text-muted-foreground sm:px-8">
        <Badge variant="secondary">Prototype</Badge>
        <span>Sample data · Nothing is saved</span>
      </div>

      {/* Main compact header (full width) */}
      <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-8">
        {/* Left: Job Title, Company */}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-tight text-foreground sm:text-lg">
              {jobTitle}
            </h1>
            <span className="text-sm font-medium text-muted-foreground">·</span>
            <span className="shrink-0 text-sm font-medium text-muted-foreground">
              {company}
            </span>
          </div>
        </div>

        {/* Right: Status badge + Properties affordance */}
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

          {/* Properties Sheet */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onOpenProperties}
            className="gap-1.5 text-xs font-medium"
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
