"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  ExternalLink,
  GripVertical,
  MapPin,
  MessageSquare,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { BoardCardView } from "@/src/server/board";
import { formatSalaryBadge } from "./salaryFormat";

/**
 * One Kanban card: a dedicated accessible drag handle plus an interactive
 * details activation button. States render as clear text and badges.
 */

const PRETTY_STATUS: Record<string, string> = {
  NEW: "New",
  TAILORED: "Tailored",
  APPLIED: "Applied",
  INTERVIEWED: "Interviewed",
  REJECTED: "Rejected",
};

function pretty(value: string | null): string {
  if (value === null) {
    return "Unknown";
  }
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

interface JobCardProps {
  card: BoardCardView;
  onOpen: (jobId: string) => void;
}

export default function JobCard({ card, onOpen }: JobCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: card.id });

  const headline = card.title ?? "Untitled posting";
  const salaryBadge = formatSalaryBadge(card);
  const hasMeta = card.location || card.arrangement || salaryBadge !== null;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group relative flex rounded-xl border border-border/80 bg-card text-card-foreground shadow-sm job-card transition-[transform,box-shadow,border-color] duration-150 hover:border-primary/40 hover:shadow-md ${
        isDragging ? "job-card-dragging opacity-90 ring-2 ring-primary ring-offset-2 z-50 shadow-xl" : ""
      }`}
      aria-label={`${headline}, ${PRETTY_STATUS[card.status] ?? card.status}`}
    >
      {/* Accessible Drag Handle */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Drag ${headline} to move it`}
        title="Drag to move (keyboard: Space, arrows, Space)"
        className="flex w-7 cursor-grab items-center justify-center rounded-l-xl border-r border-border/40 bg-muted/20 text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground active:cursor-grabbing focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none"
      >
        <GripVertical className="size-4" aria-hidden="true" />
      </button>

      {/* Main Interactive Details Button */}
      <button
        type="button"
        onClick={() => onOpen(card.id)}
        className="flex min-w-0 flex-1 flex-col gap-2 p-3.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded-r-xl cursor-pointer"
        aria-label={`Open details for ${headline}`}
      >
        {/* Top Header: Company + External Link */}
        <div className="flex items-center justify-between gap-1 w-full">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground truncate pr-5">
            {card.company ?? "Unknown Company"}
          </span>

        </div>

        {/* Title */}
        <span className="font-semibold text-sm leading-snug text-foreground group-hover:text-primary transition-colors line-clamp-2">
          {headline}
        </span>

        {/* Metadata Badges */}
        {hasMeta && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {salaryBadge !== null && (
              <Badge variant="secondary" className="text-[11px] px-2 py-0.5 font-semibold gap-1">
                <Banknote className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="font-mono tabular-nums break-words">{salaryBadge}</span>
              </Badge>
            )}
            {card.location && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="break-words">{card.location}</span>
              </span>
            )}
            {card.arrangement && (
              <Badge variant="outline" className="text-[11px] px-1.5 py-0 h-4 font-normal">
                {card.arrangement}
              </Badge>
            )}

          </div>
        )}

        {/* Resume & Tailoring Status */}
        <div className="mt-3 flex flex-wrap items-center gap-2 pt-2.5 border-t border-border/40">
          {card.tailoringState === "RUNNING" && (
            <Badge variant="warning" className="gap-1 text-[11px] py-0.5 font-medium">
              <Sparkles className="size-3.5 animate-spin" aria-hidden="true" />
              <span>Tailoring in progress…</span>
            </Badge>
          )}
          {(card.tailoringState === "FAILED" || card.tailoringState === "BLOCKED") && (
            <Badge variant="destructive" className="gap-1 text-[11px] py-0.5 font-medium">
              <AlertTriangle className="size-3.5" aria-hidden="true" />
              <span>Tailoring failed (open to retry)</span>
            </Badge>
          )}
          {card.resume !== null ? (
            card.resume.reviewState === "AWAITING_REVIEW" ? (
              <Badge variant="warning" className="gap-1 text-[11px] py-0.5 font-medium">
                <Sparkles className="size-3.5" aria-hidden="true" />
                <span>Resume v{card.resume.version}: Awaiting review</span>
              </Badge>
            ) : card.resume.reviewState === "APPROVED" ? (
              <Badge variant="success" className="gap-1 text-[11px] py-0.5 font-medium">
                <CheckCircle2 className="size-3.5" aria-hidden="true" />
                <span>Tailored (v{card.resume.version})</span>
              </Badge>
            ) : card.resume.reviewState === "REVISION_REQUESTED" ? (
              <Badge variant="destructive" className="gap-1 text-[11px] py-0.5 font-medium">
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                <span>Revision Requested (v{card.resume.version})</span>
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[11px] py-0.5 font-normal">
                Resume v{card.resume.version}: {pretty(card.resume.reviewState)}
              </Badge>
            )
          ) : (
            <span className="text-[11px] text-muted-foreground">
              Scrape: {pretty(card.scrapeState)}
              {card.scrapeReasonCode !== null ? ` (${pretty(card.scrapeReasonCode)})` : ""}
            </span>
          )}

          {card.tailoringState !== "PENDING" &&
            card.tailoringState !== "RUNNING" &&
            card.tailoringState !== "FAILED" &&
            card.tailoringState !== "BLOCKED" &&
            card.resume === null && (
              <Badge variant="outline" className="text-[11px] py-0">
                Tailoring: {pretty(card.tailoringState)}
              </Badge>
            )}
        </div>

        {/* Footer: Notes Count + Quick Review Prompt */}
        {(card.notesCount > 0 || card.resume?.reviewState === "AWAITING_REVIEW") && (
          <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
            {card.notesCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-[11px]">
                <MessageSquare className="size-3.5" aria-hidden="true" />
                <span className="font-mono tabular-nums">
                  {card.notesCount} {card.notesCount === 1 ? "note" : "notes"}
                </span>
              </span>
            ) : (
              <span />
            )}

            {card.resume?.reviewState === "AWAITING_REVIEW" && (
              <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 group-hover:underline">
                Review Resume →
              </span>
            )}
          </div>
        )}
      </button>
      {card.sourceUrl && (
        <a href={card.sourceUrl} target="_blank" rel="noreferrer"
          aria-label={`Open original job posting for ${headline}`}
          className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted">
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      )}
    </li>
  );
}
