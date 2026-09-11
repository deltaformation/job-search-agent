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
  onShowMore: (status: BoardStatus) => void;
  loadingMore: boolean;
}

export default function BoardColumn({
  status,
  total,
  cards,
  onOpen,
  onShowMore,
  loadingMore,
}: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}` });
  return (
    <section
      aria-labelledby={`column-heading-${status}`}
      className={`flex w-72 shrink-0 flex-col border bg-neutral-100 p-2 ${isOver ? "outline-2 outline-black" : ""}`}
    >
      <h2 id={`column-heading-${status}`} className="px-1 pb-2 font-semibold">
        {PRETTY_STATUS[status]}{" "}
        <span className="font-normal">
          ({cards.length} of {total})
        </span>
      </h2>
      <div ref={setNodeRef} className="min-h-24 flex-1">
        <SortableContext items={cards.map((card) => card.id)} strategy={verticalListSortingStrategy}>
          <ul className="flex flex-col gap-2">
            {cards.map((card) => (
              <JobCard key={card.id} card={card} onOpen={onOpen} />
            ))}
          </ul>
        </SortableContext>
        {cards.length === 0 && (
          <p className="px-1 py-4 text-sm">No cards. Drop here to move one in.</p>
        )}
      </div>
      {cards.length < total && (
        <button
          type="button"
          onClick={() => onShowMore(status)}
          disabled={loadingMore}
          className="mt-2 border bg-white px-3 py-1 text-sm font-semibold disabled:opacity-50"
        >
          {loadingMore ? "Loading…" : `Show more (${total - cards.length} remaining)`}
        </button>
      )}
    </section>
  );
}
