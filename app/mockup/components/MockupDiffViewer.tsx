"use client";

import { useMemo, useState } from "react";
import { Columns, ExternalLink, Eye, Rows } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { computeLineDiff, type DiffRow } from "../utils/diff";

interface MockupDiffViewerProps {
  masterText: string;
  tailoredText: string;
  pdfUrl?: string;
}

export default function MockupDiffViewer({
  masterText,
  tailoredText,
  pdfUrl = "/mockup/sample-tailored-resume.pdf",
}: MockupDiffViewerProps) {
  const [filterMode, setFilterMode] = useState<"all" | "changed_only">("changed_only");
  const [viewLayout, setViewLayout] = useState<"side_by_side" | "unified">("side_by_side");

  const diffResult = useMemo(
    () => computeLineDiff(masterText, tailoredText),
    [masterText, tailoredText]
  );

  const displayedSections = useMemo(() => {
    if (filterMode === "all") {
      return diffResult.sections;
    }
    return diffResult.sections.filter((s) => s.hasChanges);
  }, [diffResult.sections, filterMode]);

  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-card p-4  sm:p-5">
      {/* Diff Toolbar */}
      <div className="flex flex-col justify-between gap-3 border-b border-border/60 pb-3 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground sm:text-base">
              What changed
            </h3>
            <span className="font-mono text-xs text-muted-foreground">
              (+{diffResult.totalAdditions} / -{diffResult.totalDeletions})
            </span>
          </div>

        </div>

        {/* Controls: Filter + Layout + PDF Preview */}
        <div className="flex flex-wrap items-center gap-2">
          {/* All vs Changed filter */}
          <div className="inline-flex rounded-lg border border-border/70 bg-muted/30 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setFilterMode("changed_only")}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer ${
                filterMode === "changed_only"
                  ? "bg-background text-foreground "
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Changed sections only
            </button>
            <button
              type="button"
              onClick={() => setFilterMode("all")}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer ${
                filterMode === "all"
                  ? "bg-background text-foreground "
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              All sections
            </button>
          </div>

          {/* Desktop/mobile layout switch */}
          <div className="inline-flex rounded-lg border border-border/70 bg-muted/30 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setViewLayout("side_by_side")}
              aria-label="Side by side diff layout"
              className={`flex items-center gap-1 rounded-md px-2 py-1 font-medium transition-colors cursor-pointer ${
                viewLayout === "side_by_side"
                  ? "bg-background text-foreground "
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Columns className="size-3.5" />
              <span className="hidden md:inline">Split</span>
            </button>
            <button
              type="button"
              onClick={() => setViewLayout("unified")}
              aria-label="Unified unified diff layout"
              className={`flex items-center gap-1 rounded-md px-2 py-1 font-medium transition-colors cursor-pointer ${
                viewLayout === "unified"
                  ? "bg-background text-foreground "
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Rows className="size-3.5" />
              <span className="hidden md:inline">Unified</span>
            </button>
          </div>

          {/* Preview PDF Affordance */}
          <a
            href={pdfUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/20"
          >
            <Eye className="size-3.5" aria-hidden="true" />
            <span>Preview PDF</span>
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <span className="flex size-4 items-center justify-center rounded bg-rose-500/15 font-mono text-xs font-semibold text-rose-600">
            −
          </span>
          <span>Removed</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="flex size-4 items-center justify-center rounded bg-emerald-500/15 font-mono text-xs font-semibold text-emerald-600">
            +
          </span>
          <span>Added</span>
        </div>
        <span className="ml-auto font-mono text-[10px]">
          Showing {displayedSections.length} section{displayedSections.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Side-by-Side Diff Display */}
      {viewLayout === "side_by_side" ? (
        <div className="space-y-4">
          {displayedSections.map((section) => (
            <div
              key={section.title}
              className="overflow-hidden rounded-lg border border-border/60 bg-muted/10 text-xs"
            >
              {/* Section Title Banner */}
              <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3 py-1.5 font-semibold text-foreground">
                <span className="text-xs">{section.title}</span>
                {section.hasChanges ? (
                  <Badge variant="outline" className="border-primary/40 text-[10px] text-primary">
                    Modified
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] text-muted-foreground">
                    Unchanged
                  </Badge>
                )}
              </div>

              {/* Two Column Grid */}
              <div className="grid grid-cols-2 divide-x divide-border/60 font-mono text-[11px] leading-5">
                {/* Column Headers */}
                <div className="bg-muted/20 px-3 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground">
                  Original
                </div>
                <div className="bg-muted/20 px-3 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground">
                  Tailored
                </div>

                {/* Rows */}
                {section.rows.map((row: DiffRow) => {
                  const isModified = row.type === "modified";
                  const isRemoved = row.type === "removed";
                  const isAdded = row.type === "added";

                  return (
                    <div key={row.id} className="contents">
                      {/* Left Cell (Master) */}
                      <div
                        className={`flex min-w-0 overflow-x-auto py-0.5 pl-2 pr-3 whitespace-pre ${
                          isRemoved || isModified
                            ? "bg-rose-500/10 text-rose-900 dark:text-rose-200 border-l-2 border-rose-500"
                            : "text-muted-foreground"
                        }`}
                      >
                        <span className="mr-2 inline-block w-6 shrink-0 select-none text-right font-mono text-[10px] text-muted-foreground/60 tabular-nums">
                          {row.leftLineNumber ?? ""}
                        </span>
                        <span
                          className="mr-1 inline-block w-3 select-none text-rose-600 font-semibold"
                          aria-label={isRemoved || isModified ? "Removed line" : undefined}
                        >
                          {isRemoved || isModified ? "−" : " "}
                        </span>
                        <span className="flex-1">{row.leftContent || " "}</span>
                      </div>

                      {/* Right Cell (Tailored) */}
                      <div
                        className={`flex min-w-0 overflow-x-auto py-0.5 pl-2 pr-3 whitespace-pre ${
                          isAdded || isModified
                            ? "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 border-l-2 border-emerald-500"
                            : "text-foreground"
                        }`}
                      >
                        <span className="mr-2 inline-block w-6 shrink-0 select-none text-right font-mono text-[10px] text-muted-foreground/60 tabular-nums">
                          {row.rightLineNumber ?? ""}
                        </span>
                        <span
                          className="mr-1 inline-block w-3 select-none text-emerald-600 font-semibold"
                          aria-label={isAdded || isModified ? "Added line" : undefined}
                        >
                          {isAdded || isModified ? "+" : " "}
                        </span>
                        <span className="flex-1">{row.rightContent || " "}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Unified View (Mobile Friendly) */
        <div className="space-y-4">
          {displayedSections.map((section) => (
            <div
              key={section.title}
              className="overflow-hidden rounded-lg border border-border/60 bg-muted/10 text-xs"
            >
              <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3 py-1.5 font-semibold text-foreground">
                <span className="text-xs">{section.title}</span>
                {section.hasChanges && (
                  <Badge variant="outline" className="border-primary/40 text-[10px] text-primary">
                    Modified
                  </Badge>
                )}
              </div>

              <div className="divide-y divide-border/30 font-mono text-[11px] leading-5">
                {section.unifiedLines.map((line) => {
                  const isRemoved = line.type === "removed";
                  const isAdded = line.type === "added";

                  return (
                    <div
                      key={line.id}
                      className={`flex min-w-0 overflow-x-auto py-0.5 pl-2 pr-3 whitespace-pre ${
                        isRemoved
                          ? "bg-rose-500/10 text-rose-900 dark:text-rose-200 border-l-2 border-rose-500"
                          : isAdded
                            ? "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 border-l-2 border-emerald-500"
                            : "text-muted-foreground"
                      }`}
                    >
                      <span className="mr-2 inline-block w-6 shrink-0 select-none text-right font-mono text-[10px] text-muted-foreground/60 tabular-nums">
                        {line.lineNumberLeft ?? line.lineNumberRight ?? ""}
                      </span>
                      <span
                        className={`mr-1 inline-block w-3 select-none font-semibold ${
                          isRemoved
                            ? "text-rose-600"
                            : isAdded
                              ? "text-emerald-600"
                              : "text-muted-foreground/40"
                        }`}
                        aria-label={
                          isRemoved
                            ? "Removed line"
                            : isAdded
                              ? "Added line"
                              : "Unchanged line"
                        }
                      >
                        {isRemoved ? "−" : isAdded ? "+" : " "}
                      </span>
                      <span className="flex-1">{line.content || " "}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
