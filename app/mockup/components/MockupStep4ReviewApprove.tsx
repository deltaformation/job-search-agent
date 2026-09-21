"use client";

import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Check,
  FileText,
  Minus,
  Plus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  countChanges,
  diffLines,
  displayLine,
  groupBySection,
  splitLines,
  type SideRow,
} from "../utils/lineDiff";
import {
  MASTER_TEXT,
  tailoredTextFor,
} from "../fixtures/diffFixtures";
import type { JobFixture } from "../fixtures/jobDescription";
import type { MasterResumeFixture } from "../fixtures/masterResume";
import type { TailoredResumeFixture } from "../fixtures/tailoredResume";
import MockupBoardCardPreview from "./MockupBoardCardPreview";
import MockupDeclineModal from "./MockupDeclineModal";
import MockupRevisionModal from "./MockupRevisionModal";
import { MockupMasterViewer } from "./MockupViewers";

interface MockupStep4ReviewApproveProps {
  job: JobFixture;
  master: MasterResumeFixture;
  activeTailoredResume: TailoredResumeFixture;
  allVersions: TailoredResumeFixture[];
  activeVersionIndex: number;
  primaryVersionIndex: number | null;
  onSelectVersion: (index: number) => void;
  onApprove: () => void;
  onRequestChanges: (note: string) => void;
  onDecline: (reason: string) => void;
}

function DiffCell({ line, marker }: { line: string; marker: "del" | "add" | null }) {
  const { text, level } = displayLine(line);
  return (
    <span
      className={cn(
        "block whitespace-pre-wrap break-words",
        level === 2 && "font-semibold text-foreground",
        level === 3 && "font-semibold text-foreground",
      )}
    >
      {marker === "del" ? (
        <span aria-hidden="true" className="mr-1.5 font-mono font-semibold text-rose-700 dark:text-rose-300">−</span>
      ) : null}
      {marker === "add" ? (
        <span aria-hidden="true" className="mr-1.5 font-mono font-semibold text-emerald-700 dark:text-emerald-300">+</span>
      ) : null}
      {text === "" ? "\u00a0" : text}
    </span>
  );
}

function SideBySideDiff({ rows, version }: { rows: SideRow[]; version: 1 | 2 }) {
  return (
    <div className="hidden overflow-x-auto rounded-xl border border-border/70 md:block">
      <div className="grid min-w-[56rem] grid-cols-2">
        <p className="border-b border-border/60 bg-muted/50 px-3 py-2 text-xs font-semibold text-muted-foreground">
          Original master
        </p>
        <p className="border-b border-border/60 bg-muted/50 px-3 py-2 text-xs font-semibold text-foreground">
          Tailored sample v{version}
        </p>
      </div>
      <div className="grid min-w-[56rem] grid-cols-2 text-[13px] leading-relaxed">
        {rows.map((row, index) => {
          const leftChanged = row.kind === "del" || row.kind === "change";
          const rightChanged = row.kind === "add" || row.kind === "change";
          return (
            <div key={index} className="col-span-2 grid grid-cols-subgrid border-b border-border/40 last:border-b-0">
              <div
                className={cn(
                  "flex gap-2 px-3 py-1",
                  leftChanged && "bg-rose-50 dark:bg-rose-950/30",
                  row.kind === "add" && "bg-muted/30",
                )}
              >
                <span aria-hidden="true" className="w-6 shrink-0 select-none text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {row.leftNo ?? ""}
                </span>
                <div className="min-w-0 flex-1">
                  {row.left === null ? (
                    <span aria-hidden="true" className="block text-muted-foreground/50">{"\u00a0"}</span>
                  ) : (
                    <DiffCell line={row.left} marker={leftChanged ? "del" : null} />
                  )}
                </div>
              </div>
              <div
                className={cn(
                  "flex gap-2 border-l border-border/40 px-3 py-1",
                  rightChanged && "bg-emerald-50 dark:bg-emerald-950/30",
                  row.kind === "del" && "bg-muted/30",
                )}
              >
                <span aria-hidden="true" className="w-6 shrink-0 select-none text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {row.rightNo ?? ""}
                </span>
                <div className="min-w-0 flex-1">
                  {row.right === null ? (
                    <span aria-hidden="true" className="block text-muted-foreground/50">{"\u00a0"}</span>
                  ) : (
                    <DiffCell line={row.right} marker={rightChanged ? "add" : null} />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UnifiedDiff({ rows, version }: { rows: SideRow[]; version: 1 | 2 }) {
  return (
    <ol className="space-y-1 text-[13px] leading-relaxed md:hidden" aria-label={`Unified sample diff v${version}`}>
      {rows.map((row, index) => {
        if (row.kind === "same" && row.left !== null) {
          return (
            <li key={index} className="rounded-md px-3 py-1">
              <DiffCell line={row.left} marker={null} />
            </li>
          );
        }
        return (
          <li key={index} className="space-y-1">
            {row.left !== null && row.kind !== "add" ? (
              <div className="rounded-md bg-rose-50 px-3 py-1 dark:bg-rose-950/30">
                <DiffCell line={row.left} marker="del" />
              </div>
            ) : null}
            {row.right !== null && row.kind !== "del" ? (
              <div className="rounded-md bg-emerald-50 px-3 py-1 dark:bg-emerald-950/30">
                <DiffCell line={row.right} marker="add" />
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export default function MockupStep4ReviewApprove({
  job,
  master,
  activeTailoredResume,
  allVersions,
  activeVersionIndex,
  primaryVersionIndex,
  onSelectVersion,
  onApprove,
  onRequestChanges,
  onDecline,
}: MockupStep4ReviewApproveProps) {
  const [sectionFilter, setSectionFilter] = useState<"all" | "changed">("all");
  const [revisionModalOpen, setRevisionModalOpen] = useState(false);
  const [declineModalOpen, setDeclineModalOpen] = useState(false);
  const [masterViewerOpen, setMasterViewerOpen] = useState(false);

  const isApproved = activeTailoredResume.reviewState === "APPROVED";
  const isDeclined = activeTailoredResume.reviewState === "DECLINED";

  const viewingNumber: 1 | 2 = (activeVersionIndex === 1 ? 2 : 1);
  const tailoredText = useMemo(() => tailoredTextFor(viewingNumber), [viewingNumber]);

  const sections = useMemo(
    () => groupBySection(diffLines(splitLines(MASTER_TEXT), splitLines(tailoredText))),
    [tailoredText],
  );
  const visibleSections = sectionFilter === "all" ? sections : sections.filter((s) => s.changed);
  const totals = useMemo(
    () => countChanges(sections.flatMap((section) => section.rows)),
    [sections],
  );

  return (
    <div className="w-full space-y-8">
      {/* Version Selector (if multiple versions exist) */}
      {allVersions.length > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-card p-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground">Version</span>
            <div className="flex gap-1.5" role="group" aria-label="Sample versions">
              {allVersions.map((ver, idx) => {
                const isSelected = activeVersionIndex === idx;
                const isThisApproved = ver.reviewState === "APPROVED";
                const isThisDeclined = ver.reviewState === "DECLINED";

                return (
                  <button
                    key={ver.version}
                    type="button"
                    onClick={() => onSelectVersion(idx)}
                    className={cn(
                      "rounded-md px-3 py-1.5 font-medium transition-colors cursor-pointer text-xs",
                      isSelected
                        ? "bg-primary text-primary-foreground "
                        : "border border-border/70 bg-muted/30 hover:bg-muted text-muted-foreground",
                    )}
                  >
                    v{ver.version}{" "}
                    {isThisApproved
                      ? "✓ (Approved)"
                      : isThisDeclined
                        ? "✕ (Declined)"
                        : "· (Awaiting review)"}
                  </button>
                );
              })}
            </div>
          </div>
          {primaryVersionIndex !== null && (
            <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold">
              Primary approved: Version {allVersions[primaryVersionIndex]?.version}
            </span>
          )}
        </div>
      )}

      {/* KPI Section: Resume comparison */}
      <section
        aria-labelledby="score-improvement-heading"
        className="rounded-xl border border-border/70 bg-card p-6  sm:p-7"
      >
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
          <h2 id="score-improvement-heading" className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
            Resume comparison
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 sm:items-center">
          {/* 45% Original Resume */}
          <div className="flex flex-col items-center justify-center rounded-xl border border-border/60 bg-muted/20 p-5 text-center">
            <span className="text-4xl font-extrabold tracking-tight text-muted-foreground sm:text-5xl">
              45%
            </span>
            <span className="mt-2 text-xs font-semibold tracking-wide text-muted-foreground">
              Original Resume
            </span>
          </div>

          {/* +37 points */}
          <div className="flex flex-col items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-5 text-center ">
            <div className="flex items-center gap-1">
              <span className="text-4xl font-extrabold tracking-tight text-emerald-600 dark:text-emerald-400 sm:text-5xl">
                +37
              </span>
              <ArrowUpRight className="size-6 text-emerald-600 dark:text-emerald-400 stroke-[3]" />
            </div>
            <span className="mt-2 text-xs font-semibold tracking-wide text-emerald-700 dark:text-emerald-300">
              points
            </span>
          </div>

          {/* 82% Tailored Resume */}
          <div className="flex flex-col items-center justify-center rounded-xl border border-primary/50 bg-primary/10 p-5 text-center ">
            <span className="text-4xl font-extrabold tracking-tight text-primary sm:text-5xl">
              82%
            </span>
            <span className="mt-2 text-xs font-semibold tracking-wide text-primary">
              Tailored Resume
            </span>
          </div>
        </div>
      </section>

      {/* Next Section: What Changed (adopted from /mockup2) */}
      <section aria-labelledby="what-changed-heading" className="space-y-4 rounded-xl border border-border/50 bg-card p-5  sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/50 pb-4">
          <div>
            <h3 id="what-changed-heading" className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              What changed
            </h3>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm" aria-live="polite">
              {totals.removals} removed lines · {totals.additions} added lines ·{" "}
              {sections.filter((s) => s.changed).length} of {sections.length} sections changed
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Filter buttons */}
            <div className="flex items-center gap-1" role="group" aria-label="Diff section filter">
              <button
                type="button"
                onClick={() => setSectionFilter("all")}
                aria-pressed={sectionFilter === "all"}
                className={cn(
                  "cursor-pointer rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                  sectionFilter === "all"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                All sections
              </button>
              <button
                type="button"
                onClick={() => setSectionFilter("changed")}
                aria-pressed={sectionFilter === "changed"}
                className={cn(
                  "cursor-pointer rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                  sectionFilter === "changed"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                Changed sections only
              </button>
            </div>

            {/* Preview PDF Buttons */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMasterViewerOpen(true)}
              className="gap-1.5 text-xs"
            >
              <FileText className="size-3.5" />
              <span>Original master (Preview PDF)</span>
            </Button>
            <Button type="button" variant="outline" size="sm" asChild className="gap-1.5 text-xs">
              <a href="/mockup/sample-tailored-resume.pdf" target="_blank" rel="noopener noreferrer">
                <FileText className="size-3.5 text-primary" />
                <span>Tailored sample v{viewingNumber} (Preview PDF)</span>
              </a>
            </Button>
          </div>
        </div>

        {/* Diff Legend */}
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground pt-1" aria-label="Diff legend">
          <li className="inline-flex items-center gap-1.5">
            <Minus className="size-3.5 text-rose-600 dark:text-rose-400" aria-hidden="true" />
            <span>Removed (red, −)</span>
          </li>
          <li className="inline-flex items-center gap-1.5">
            <Plus className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <span>Added in tailored sample (green, +)</span>
          </li>
        </ul>

        {/* Grouped Section Diff Rows */}
        <div className="space-y-6 pt-2">
          {visibleSections.map((section) => (
            <div key={section.title} className="space-y-2">
              <h4 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-foreground">
                <span>{section.title}</span>
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                    section.changed
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {section.changed ? "Changed" : "Unchanged"}
                </span>
              </h4>
              <SideBySideDiff rows={section.rows} version={viewingNumber} />
              <UnifiedDiff rows={section.rows} version={viewingNumber} />
            </div>
          ))}
        </div>
      </section>

      {/* After the change diff: Review decision */}
      <section
        aria-labelledby="decide-heading"
        className="space-y-4 rounded-xl border border-border/50 bg-card p-5  sm:p-6"
      >
        <h3 id="decide-heading" className="text-base font-semibold tracking-tight text-foreground sm:text-lg">
          Review decision
        </h3>

        {!isApproved && !isDeclined ? (
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              onClick={onApprove}
              className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer"
            >
              <Check className="size-4" aria-hidden="true" />
              <span>Approve version</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRevisionModalOpen(true)}
              className="cursor-pointer text-xs"
            >
              <span>Request changes</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeclineModalOpen(true)}
              className="cursor-pointer text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-950/30"
            >
              <span>Decline version</span>
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              {isApproved ? (
                <Badge className="bg-emerald-600 text-white px-3 py-1 text-xs gap-1.5">
                  <Check className="size-3.5" />
                  <span>Approved · Primary</span>
                </Badge>
              ) : (
                <Badge variant="outline" className="border-rose-500/40 text-rose-600 bg-rose-500/10 px-3 py-1 text-xs gap-1.5">
                  <Minus className="size-3.5" />
                  <span>Declined</span>
                </Badge>
              )}

              {allVersions.length < 2 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRevisionModalOpen(true)}
                  className="text-xs"
                >
                  <span>Create revision</span>
                </Button>
              )}
            </div>

            {/* Post-Approval Board Card Preview */}
            {isApproved && (
              <div className="pt-2">
                <MockupBoardCardPreview
                  job={job}
                  approvedVersionLabel={`Version ${activeTailoredResume.version}`}
                  pdfUrl="/mockup/sample-tailored-resume.pdf"
                />
              </div>
            )}
          </div>
        )}


      </section>

      {/* Revision Modal Dialog */}
      <MockupRevisionModal
        open={revisionModalOpen}
        onOpenChange={setRevisionModalOpen}
        onSubmitRevision={onRequestChanges}
      />

      {/* Decline Reason Modal Dialog */}
      <MockupDeclineModal
        open={declineModalOpen}
        onOpenChange={setDeclineModalOpen}
        onDecline={onDecline}
      />

      {/* Master Resume Preview Viewer */}
      <MockupMasterViewer
        open={masterViewerOpen}
        onOpenChange={setMasterViewerOpen}
        master={master}
      />
    </div>
  );
}
