"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { BoardStatus } from "@/src/domain/enums";
import type { BoardCardView } from "@/src/server/board";
import JobCard from "./JobCard";

/**
 * One Kanban column: a droppable container (dropping on empty space appends)
 * around the sortable cards, with a count-bearing heading and load-more.
 */

const PRETTY_STATUS: Record<BoardStatus, string> = {
  NEW: "New",
  TAILORED: "Tailored",
  APPLIED: "Applied",
  INTERVIEWED: "Interviewed",
  REJECTED: "Rejected",
};

interface BoardColumnProps {
  status: BoardStatus;
  total: number;
  cards: BoardCardView[];
  onOpen: (jobId: string) => void;
  onOpenProperties?: (jobId: string) => void;
  onShowMore: (status: BoardStatus) => void;
  loadingMore: boolean;
}

export default function BoardColumn({
  status,
  total,
  cards,
  onOpen,
  onOpenProperties,
  onShowMore,
  loadingMore,
}: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}` });
  return (
    <section
      aria-labelledby={`column-heading-${status}`}
      className={`flex min-h-0 w-[360px] min-w-[340px] 2xl:w-[400px] shrink-0 flex-col rounded-xl border border-border/60 bg-muted/40 ${
        isOver ? "ring-2 ring-primary ring-offset-2 bg-muted/70" : ""
      }`}
    >
      <div className="shrink-0 flex items-center justify-between border-b border-border/40 px-3 py-2.5">
        <h2
          id={`column-heading-${status}`}
          className="text-sm font-semibold tracking-tight text-foreground"
        >
          {PRETTY_STATUS[status]}{" "}
          <span className="font-mono tabular-nums text-xs font-medium text-muted-foreground">
            ({cards.length} of {total})
          </span>
        </h2>
      </div>

      <div ref={setNodeRef} className="board-column-scroll min-h-0 flex-1 overflow-y-auto p-2.5">
        <SortableContext
          items={cards.map((card) => card.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="flex flex-col gap-2">
            {cards.map((card) => (
              <JobCard
                key={card.id}
                card={card}
                onOpen={onOpen}
                onOpenProperties={onOpenProperties}
              />
            ))}
          </ul>
        </SortableContext>
        {cards.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/80 py-8 px-4 text-center">
            <p className="text-xs text-muted-foreground">
              No cards. Drop here to move one in.
            </p>
          </div>
        )}
      </div>

      {cards.length < total && (
        <button
          type="button"
          onClick={() => onShowMore(status)}
          disabled={loadingMore}
          className="shrink-0 w-full rounded-md border border-input bg-background py-1.5 text-xs font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-50 cursor-pointer transition-colors"
        >
          {loadingMore ? "Loading…" : `Show more (${total - cards.length} remaining)`}
        </button>
      )}
    </section>
  );
}
