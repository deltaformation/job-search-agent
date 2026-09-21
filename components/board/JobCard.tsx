"use client";

import { memo, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  Banknote,
  CheckCircle2,
  Download,
  ExternalLink,
  GripVertical,
  History,
  MapPin,
  MessageSquare,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { artifactDownloadHref } from "@/src/domain/tailorEntry";
import type { BoardCardView } from "@/src/server/board";
import { formatSalaryBadge } from "./salaryFormat";

/**
 * Compact status-first Kanban card:
 * - Status top-right across all 5 columns (C7)
 * - Accessible drag handle with drag/activation isolation (C1)
 * - Sibling button isolation (no nested <button> in <button>)
 * - Dedicated Properties button opens drawer without navigating (C1)
 * - Activation/keyboard opens exact job route (C1)
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

const DAY_MS = 86_400_000;

function followUpLabel(status: string, appliedAt: string | null, now: number): string | null {
  if (status !== "APPLIED" || appliedAt === null) {
    return null;
  }
  const appliedMs = Date.parse(appliedAt);
  if (Number.isNaN(appliedMs)) {
    return null;
  }
  const days = Math.floor((now - appliedMs) / DAY_MS);
  if (days >= 30) {
    return "Follow-up suggested (30d+)";
  }
  if (days >= 14) {
    return "Follow-up suggested (14d)";
  }
  if (days >= 7) {
    return "Follow-up suggested (7d)";
  }
  return null;
}

interface JobCardProps {
  card: BoardCardView;
  onOpen: (jobId: string) => void;
  onOpenProperties?: (jobId: string) => void;
}

function JobCard({ card, onOpen, onOpenProperties }: JobCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: card.id });

  const headline = card.title ?? "Untitled posting";
  const salaryBadge = formatSalaryBadge(card);
  const hasMeta = card.location || card.arrangement || salaryBadge !== null;
  const [now] = useState(() => Date.now());
  const followUp = followUpLabel(card.status, card.appliedAt, now);

  const handleCardClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button, a")) {
      return;
    }
    onOpen(card.id);
  };

  const handlePropertiesClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onOpenProperties) {
      onOpenProperties(card.id);
    } else {
      onOpen(card.id);
    }
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={handleCardClick}
      className={`group relative flex w-full rounded-xl border border-border/80 bg-card text-card-foreground shadow-sm job-card transition-[transform,box-shadow,border-color] duration-150 hover:border-primary/40 hover:shadow-md cursor-pointer ${
        isDragging ? "job-card-dragging opacity-90 ring-2 ring-primary ring-offset-2 z-50 shadow-xl" : ""
      }`}
      aria-label={`${headline}, ${PRETTY_STATUS[card.status] ?? card.status}`}
    >
      {/* Accessible Drag Handle (does not navigate, C1) */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Drag ${headline} to move it`}
        title="Drag to move (keyboard: Space, arrows, Space)"
        className="flex w-7 cursor-grab items-center justify-center rounded-l-xl border-r border-border/40 bg-muted/20 text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground active:cursor-grabbing focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-none"
      >
        <GripVertical className="size-4" aria-hidden="true" />
      </button>

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        {/* Top Header: Company on Left, Status Top-Right (C7) */}
        <div className="flex items-center justify-between gap-1 w-full pr-6">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
            {card.company ?? "Unknown Company"}
          </span>
          <Badge
            variant={card.status === "TAILORED" ? "default" : "secondary"}
            className={`text-[10px] px-1.5 py-0 h-4 font-semibold shrink-0 ${
              card.status === "TAILORED"
                ? "bg-emerald-600 text-white hover:bg-emerald-600"
                : "bg-muted text-foreground"
            }`}
          >
            {PRETTY_STATUS[card.status] ?? card.status}
          </Badge>
        </div>

        {/* Primary Interactive Details / Route Activation Button (C1, A6) */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(card.id);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              onOpen(card.id);
            }
          }}
          className="font-semibold text-sm leading-snug text-foreground hover:text-primary transition-colors text-left line-clamp-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded cursor-pointer"
          aria-label={`Open details for ${headline}`}
        >
          {headline}
        </button>

        {/* Secondary Metadata Badges */}
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

        {/* Tailoring & Resume Status Indicators */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
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
            card.scrapeState !== "SUCCEEDED" && (
              <span className="text-[11px] text-muted-foreground">
                Scrape: {pretty(card.scrapeState)}
                {card.scrapeReasonCode !== null ? ` (${pretty(card.scrapeReasonCode)})` : ""}
              </span>
            )
          )}
        </div>

        {/* Footer: Properties Action + Notes Count + Follow-up (nested isolation, C1) */}
        <div className="mt-1 flex items-center justify-between border-t border-border/40 pt-2 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            {/* Properties button opens legacy drawer without navigating (C1, Deliverable 2/5) */}
            <button
              type="button"
              onClick={handlePropertiesClick}
              aria-label={`Open properties for ${headline}`}
              className="inline-flex items-center gap-1 rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-muted transition-colors cursor-pointer focus-visible:ring-1 focus-visible:ring-ring"
            >
              <SlidersHorizontal className="size-3" aria-hidden="true" />
              <span>Properties</span>
            </button>

            {card.notesCount > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px]">
                <MessageSquare className="size-3" aria-hidden="true" />
                <span className="font-mono tabular-nums">{card.notesCount}</span>
              </span>
            )}

            {/* Download Resume (H3/H4): the batched selected-approved
                PDF only. Awaiting/declined drafts render an explicit
                unavailable state — never a fallback link. */}
            {card.selectedApprovedPdfArtifactId !== null ? (
              <a
                href={artifactDownloadHref(card.selectedApprovedPdfArtifactId)}
                onClick={(event) => event.stopPropagation()}
                aria-label={`Download approved resume for ${headline}`}
                title="Download approved resume (PDF)"
                className="inline-flex items-center gap-1 rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium text-foreground hover:bg-muted transition-colors focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Download className="size-3" aria-hidden="true" />
                <span>Resume</span>
              </a>
            ) : (
              card.resume !== null && (
                <span
                  title="No approved resume yet — awaiting and declined versions are never offered for download."
                  className="inline-flex items-center gap-1 px-1 py-0.5 text-[10px] text-muted-foreground/60"
                >
                  <Download className="size-3" aria-hidden="true" />
                  <span>Unavailable</span>
                </span>
              )
            )}
          </div>

          {followUp !== null && (
            <Badge variant="outline" className="gap-1 text-[10px] py-0 font-normal text-muted-foreground">
              <History className="size-3" aria-hidden="true" />
              <span>{followUp}</span>
            </Badge>
          )}
        </div>
      </div>

      {/* External link with stopPropagation (does not navigate, C1) */}
      {card.sourceUrl && (
        <a
          href={card.sourceUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Open original job posting for ${headline}`}
          className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      )}
    </li>
  );
}

export default memo(
  JobCard,
  (prev, next) =>
    prev.card === next.card &&
    prev.onOpen === next.onOpen &&
    prev.onOpenProperties === next.onOpenProperties,
);
