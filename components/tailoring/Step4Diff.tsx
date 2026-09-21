"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  displayReviewLine,
  diffReviewTexts,
  type ReviewDiffRow,
  type ReviewDiffSegment,
} from "@/src/domain/reviewDiff";
import type { WorkflowReviewSegment } from "@/src/domain/workflowReview";

/**
 * Production master-versus-tailored diff (WO-1.3-G). Runs the pure
 * bounded `diffReviewTexts` over the frozen master text and the
 * exact canonical tailored text: All/Changed section filter,
 * non-color row markers (-/+/~/=) and provenance tags (V/A/E),
 * source-operation attribution, and explicit excluded rendering.
 * Over-budget inputs render the complete side-by-side fallback —
 * never truncated, never a hang. Lines render as React string
 * children (hostile HTML is inert text, never interpreted).
 */

function toDiffSegments(
  segments: WorkflowReviewSegment[],
): ReviewDiffSegment[] {
  return segments
    .filter(
      (segment) =>
        segment.provenance === "VERIFIED_SOURCE" ||
        segment.provenance === "USER_ACCEPTED_AI" ||
        segment.provenance === "USER_EDITED",
    )
    .map((segment) => ({
      segmentId: segment.segmentId,
      kind: segment.kind,
      roleId: segment.roleId,
      text: segment.text,
      provenance: segment.provenance as ReviewDiffSegment["provenance"],
      sourceOperationId: segment.sourceOperationId,
    }));
}

const PROVENANCE_LABEL: Record<string, string> = {
  V: "Verified source",
  A: "AI suggestion accepted",
  E: "User edit",
};

function RowBadge({ row }: { row: ReviewDiffRow }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden="true"
        className="inline-block w-4 shrink-0 text-center font-mono text-[11px] font-bold"
      >
        {row.kind === "same" ? "=" : row.marker}
      </span>
      {row.provenanceTag !== null && (
        <span
          title={PROVENANCE_LABEL[row.provenanceTag] ?? row.provenanceTag}
          className="inline-block shrink-0 rounded border border-border/70 px-1 font-mono text-[10px] font-bold"
        >
          {row.provenanceTag}
        </span>
      )}
      {row.leftExcluded && (
        <span
          title="Removed by an explicit exclude operation"
          className="inline-block shrink-0 rounded border border-border/70 bg-muted px-1 text-[10px] font-semibold"
        >
          Excl
        </span>
      )}
    </span>
  );
}

function DiffLine({ text }: { text: string | null }) {
  if (text === null) {
    return <span className="text-muted-foreground/40">∅</span>;
  }
  const { text: display, level } = displayReviewLine(text);
  return (
    <span className={level > 0 ? "font-semibold" : undefined}>{display}</span>
  );
}

export default function Step4Diff({
  masterText,
  tailoredText,
  segments,
  excludedTexts,
}: {
  masterText: string;
  tailoredText: string;
  segments: WorkflowReviewSegment[];
  excludedTexts: string[];
}) {
  const [changedOnly, setChangedOnly] = useState(false);
  const result = useMemo(
    () =>
      diffReviewTexts({
        masterText,
        tailoredText,
        segments: toDiffSegments(segments),
        excludedMasterTexts: excludedTexts,
      }),
    [masterText, tailoredText, segments, excludedTexts],
  );
  const [openOp, setOpenOp] = useState<string | null>(null);

  if (!result.diffAvailable) {
    const masterLines = masterText.split("\n");
    const tailoredLines = tailoredText.split("\n");
    const pairs = Math.max(masterLines.length, tailoredLines.length);
    return (
      <div className="space-y-3">
        <div
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
        >
          <p className="font-semibold">Line diff unavailable for this size.</p>
          <p className="mt-1 text-muted-foreground">
            {result.reason === "over-line-cap"
              ? "One side exceeds 10,000 lines, so the bounded diff declined rather than hang. "
              : "Diff work exceeds 1,000,000 units, so the bounded diff declined rather than hang. "}
            Both complete texts render below — nothing is truncated.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-border/60">
            <p className="border-b border-border/60 px-3 py-2 text-xs font-semibold">
              Original master (frozen)
            </p>
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-relaxed">
              {masterText}
            </pre>
          </div>
          <div className="rounded-lg border border-border/60">
            <p className="border-b border-border/60 px-3 py-2 text-xs font-semibold">
              Tailored resume (exact canonical)
            </p>
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-relaxed">
              {tailoredText}
            </pre>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {pairs} line positions shown in full.
        </p>
      </div>
    );
  }

  const sections = changedOnly
    ? result.sections.filter((section) => section.changed)
    : result.sections;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Diff filter"
          className="inline-flex overflow-hidden rounded-md border border-border/70 text-xs"
        >
          <button
            type="button"
            onClick={() => setChangedOnly(false)}
            aria-pressed={!changedOnly}
            className={`px-2.5 py-1 font-medium ${!changedOnly ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted/40"}`}
          >
            All lines
          </button>
          <button
            type="button"
            onClick={() => setChangedOnly(true)}
            aria-pressed={changedOnly}
            className={`px-2.5 py-1 font-medium ${changedOnly ? "bg-primary text-primary-foreground" : "bg-card hover:bg-muted/40"}`}
          >
            Changed only
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground" role="status">
          {result.removals} removed · {result.additions} added · markers: = same, - removed, +
          added, ~ changed · provenance: V verified, A accepted AI, E user edit
        </p>
      </div>
      {sections.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
          No changed sections — the tailored resume matches the frozen master line for line.
        </p>
      ) : (
        <div className="space-y-4">
          {sections.map((section) => (
            <div key={section.title} className="overflow-hidden rounded-lg border border-border/60">
              <p className="border-b border-border/60 bg-muted/30 px-3 py-1.5 text-xs font-semibold">
                {section.title}
                {!section.changed && (
                  <span className="ml-2 font-normal text-muted-foreground">(unchanged)</span>
                )}
              </p>
              <ol className="divide-y divide-border/40 font-mono text-[11px] leading-relaxed">
                {section.rows.map((row, index) => (
                  <li
                    key={`${row.leftNo ?? "·"}-${row.rightNo ?? "·"}-${index}`}
                    className={`grid grid-cols-[auto_1fr_1fr] items-start gap-2 px-2 py-0.5 ${
                      row.kind === "same" ? "" : "bg-muted/20"
                    }`}
                  >
                    <RowBadge row={row} />
                    <span
                      className={`whitespace-pre-wrap break-words ${row.kind === "del" || row.kind === "change" ? "text-foreground" : "text-muted-foreground"} ${row.leftExcluded ? "line-through decoration-2" : ""}`}
                      title={row.leftNo === null ? "no master line" : `master line ${row.leftNo}`}
                    >
                      <DiffLine text={row.left} />
                    </span>
                    <span
                      className={`whitespace-pre-wrap break-words ${row.kind === "add" || row.kind === "change" ? "text-foreground" : "text-muted-foreground"}`}
                      title={row.rightNo === null ? "no tailored line" : `tailored line ${row.rightNo}`}
                    >
                      <DiffLine text={row.right} />
                      {row.attribution?.sourceOperationId && (
                        <Button
                          type="button"
                          variant="link"
                          size="sm"
                          className="ml-1 h-auto p-0 font-mono text-[10px]"
                          title={`Source operation ${row.attribution.sourceOperationId}`}
                          onClick={() =>
                            setOpenOp(
                              openOp === row.attribution?.sourceOperationId
                                ? null
                                : (row.attribution?.sourceOperationId ?? null),
                            )
                          }
                        >
                          [{row.attribution.sourceOperationId.slice(0, 8)}]
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
      {openOp !== null && (
        <p className="text-[11px] text-muted-foreground" role="status">
          Source operation <span className="font-mono">{openOp}</span> — see the ordered
          operations list for its exact frozen bytes.
        </p>
      )}
    </div>
  );
}
