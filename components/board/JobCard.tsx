"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BoardCardView } from "@/src/server/board";

/**
 * One Kanban card: a dedicated drag handle plus a details button. Splitting
 * the two keeps pointer dragging, keyboard dragging (focus the handle,
 * Space to lift, arrows to move, Space to drop), and plain activation on
 * separate controls so they never fight. States render as text, never
 * color-only; the same moves also exist as buttons in the detail drawer.
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
  const where = [card.company, card.location].filter((part) => part !== null && part !== "");
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex gap-1 border bg-white p-2 ${isDragging ? "opacity-50" : ""}`}
      aria-label={`${headline}, ${PRETTY_STATUS[card.status] ?? card.status}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Drag ${headline} to move it`}
        title="Drag to move (keyboard: Space, arrows, Space)"
        className="cursor-grab px-1 text-lg leading-none"
      >
        <span aria-hidden="true">⠿</span>
      </button>
      <button
        type="button"
        onClick={() => onOpen(card.id)}
        className="block flex-1 cursor-pointer text-left"
        aria-label={`Open details for ${headline}`}
      >
        <span className="block font-semibold">{headline}</span>
        {where.length > 0 && <span className="block text-sm">{where.join(" · ")}</span>}
        {(card.arrangement !== null || card.salaryText !== null) && (
          <span className="block text-sm">
            {[card.arrangement, card.salaryText]
              .filter((part) => part !== null && part !== "")
              .join(" · ")}
          </span>
        )}
        <span className="mt-1 block text-xs">
          Scrape: {pretty(card.scrapeState)}
          {card.scrapeReasonCode !== null ? ` (${pretty(card.scrapeReasonCode)})` : ""}
        </span>
        {card.tailoringState !== "PENDING" && (
          <span className="block text-xs">Tailoring: {pretty(card.tailoringState)}</span>
        )}
        {card.resume !== null && (
          <span className="block text-xs">
            Resume v{card.resume.version}: {pretty(card.resume.reviewState)}
          </span>
        )}
        {card.notesCount > 0 && (
          <span className="block text-xs">
            {card.notesCount} {card.notesCount === 1 ? "note" : "notes"}
          </span>
        )}
      </button>
    </li>
  );
}
