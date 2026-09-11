"use client";

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardStatus } from "@/src/domain/enums";
import type { BoardCardView, BoardView } from "@/src/server/board";
import { apiGet, errorMessage } from "../api";
import AppliedModal from "./AppliedModal";
import BoardColumn from "./BoardColumn";
import CardDrawer from "./CardDrawer";
import CorrectDialog from "./CorrectDialog";
import { postJobMutation } from "./mutate";
import { computeDropRank } from "./rank";
import RejectDialog from "./RejectDialog";

/**
 * Kanban board: five sortable columns with pointer and keyboard dragging.
 * Drops commit through the R3-A mutation routes (never optimistically —
 * the server round-trips in milliseconds on localhost and stays the single
 * source of truth), refresh from the server afterwards, and retry once on
 * version conflicts with the fresh row version.
 */

type BoardSort = "rank" | "updated" | "created";
type DialogState =
  | { kind: "applied"; card: BoardCardView; rank: number }
  | { kind: "reject"; card: BoardCardView; rank: number }
  | { kind: "correct"; card: BoardCardView }
  | null;

const STATUSES: readonly BoardStatus[] = ["NEW", "TAILORED", "APPLIED", "INTERVIEWED", "REJECTED"];
const PAGE_SIZE = 50;

function columnOf(board: BoardView, cardId: string): BoardStatus | null {
  for (const column of board.columns) {
    if (column.cards.some((card) => card.id === cardId)) {
      return column.status;
    }
  }
  return null;
}

function findCard(board: BoardView, cardId: string): BoardCardView | null {
  for (const column of board.columns) {
    const found = column.cards.find((card) => card.id === cardId);
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}

export default function Board() {
  const [board, setBoard] = useState<BoardView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [sort, setSort] = useState<BoardSort>("rank");
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openJobId, setOpenJobId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [drawerToken, setDrawerToken] = useState(0);

  function onDialogSaved(): void {
    setDialog(null);
    setDrawerToken((token) => token + 1);
    void refresh();
  }
  const boardRef = useRef<BoardView | null>(null);
  useEffect(() => {
    boardRef.current = board;
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const limitFor = useCallback(
    (status: BoardStatus): number => limits[status] ?? PAGE_SIZE,
    [limits],
  );

  const refresh = useCallback(async (): Promise<BoardView | null> => {
    const params = new URLSearchParams();
    if (committedQuery.trim() !== "") {
      params.set("q", committedQuery.trim());
    }
    params.set("sort", sort);
    const maxLimit = Math.max(...STATUSES.map((status) => limits[status] ?? PAGE_SIZE));
    params.set("limit", String(maxLimit));
    try {
      const view = await apiGet<BoardView>(`/api/board?${params.toString()}`);
      setBoard(view);
      setError(null);
      return view;
    } catch (fetchError: unknown) {
      setError(errorMessage(fetchError));
      return null;
    }
  }, [committedQuery, sort, limits]);

  useEffect(() => {
    let cancelled = false;
    void refresh().finally(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    // Skip unchanged queries: arming setLoading(true) with no fetch behind
    // it leaves "Loading board…" stuck on screen (proven by E2E screenshot).
    if (query === committedQuery) {
      return;
    }
    const timer = setTimeout(() => {
      setCommittedQuery(query);
      setLoading(true);
    }, 300);
    return () => clearTimeout(timer);
  }, [query, committedQuery]);

  async function showMore(status: BoardStatus): Promise<void> {
    setLoadingMore(true);
    try {
      setLimits((current) => ({ ...current, [status]: (current[status] ?? PAGE_SIZE) + PAGE_SIZE }));
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * POST a mutation (one conflict retry inside), then refresh the board.
   * Returns true when the board now reflects the change.
   */
  async function mutate(
    path: string,
    body: Record<string, unknown> & { observedRowVersion: number },
    successNotice: string,
  ): Promise<boolean> {
    try {
      await postJobMutation(path, body);
    } catch (error: unknown) {
      setNotice(`Update failed: ${errorMessage(error)}`);
      await refresh();
      return false;
    }
    setNotice(successNotice);
    await refresh();
    return true;
  }

  function onDragStart(event: DragStartEvent): void {
    setActiveId(String(event.active.id));
    setNotice(null);
  }

  async function onDragEnd(event: DragEndEvent): Promise<void> {
    const current = boardRef.current;
    setActiveId(null);
    if (current === null) {
      return;
    }
    const { active, over } = event;
    if (over === null) {
      return;
    }
    const card = findCard(current, String(active.id));
    if (card === null) {
      return;
    }
    const fromStatus = columnOf(current, card.id);
    if (fromStatus === null) {
      return;
    }
    const overId = String(over.id);
    let toStatus: BoardStatus;
    let toIndex: number;
    if (overId.startsWith("column:")) {
      toStatus = overId.slice("column:".length) as BoardStatus;
      const column = current.columns.find((entry) => entry.status === toStatus);
      toIndex = column === undefined ? 0 : column.cards.length;
    } else {
      const targetColumn = columnOf(current, overId);
      if (targetColumn === null) {
        return;
      }
      toStatus = targetColumn;
      const column = current.columns.find((entry) => entry.status === toStatus);
      toIndex = column === undefined ? 0 : column.cards.findIndex((entry) => entry.id === overId);
    }
    const targetRanks = (current.columns.find((entry) => entry.status === toStatus)?.cards ?? [])
      .filter((entry) => entry.id !== card.id)
      .map((entry) => entry.rank);
    // Dropping onto itself (or an unchanged spot) is a no-op.
    if (toStatus === fromStatus && overId === card.id) {
      return;
    }
    const rank = computeDropRank(targetRanks, toIndex);
    if (toStatus === fromStatus) {
      if (rank === card.rank) {
        return;
      }
      await mutate(
        `/api/jobs/${card.id}/reorder`,
        { rank, observedRowVersion: card.rowVersion },
        "Card reordered.",
      );
      return;
    }
    if (toStatus === "TAILORED") {
      setNotice("TAILORED requires an approved resume — approval moves the card, not dragging.");
      return;
    }
    if (toStatus === "APPLIED") {
      setDialog({ kind: "applied", card, rank });
      return;
    }
    if (toStatus === "REJECTED") {
      setDialog({ kind: "reject", card, rank });
      return;
    }
    await mutate(
      `/api/jobs/${card.id}/move`,
      { to: toStatus, rank, observedRowVersion: card.rowVersion },
      `Moved to ${toStatus}.`,
    );
  }

  const announcements: Announcements = useMemo(
    () => ({
      onDragStart({ active }) {
        const card = boardRef.current === null ? null : findCard(boardRef.current, String(active.id));
        return card === null ? "Picked up a card." : `Picked up ${card.title ?? "untitled card"}.`;
      },
      onDragOver({ active, over }) {
        if (over === null) {
          return undefined;
        }
        const overId = String(over.id);
        // Stay silent over the dragged card itself so "Over another card."
        // is a true signal of landing on a different card.
        if (overId === String(active.id)) {
          return undefined;
        }
        if (overId.startsWith("column:")) {
          return `Over ${overId.slice("column:".length)} column, end of list.`;
        }
        return "Over another card.";
      },
      onDragEnd({ over }) {
        // Neutral: no-op drops (onto itself, unchanged spot) save nothing,
        // and the outcome notice below carries the result either way.
        return over === null ? "Drop cancelled." : "Dropped.";
      },
      onDragCancel() {
        return "Drag cancelled.";
      },
    }),
    [],
  );

  const activeCard = activeId !== null && board !== null ? findCard(board, activeId) : null;

  return (
    <div>
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="board-search" className="block font-semibold">
            Search cards
          </label>
          <input
            id="board-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, company, or location"
            className="mt-1 border p-2"
          />
        </div>
        <div>
          <label htmlFor="board-sort" className="block font-semibold">
            Sort
          </label>
          <select
            id="board-sort"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as BoardSort);
              setLoading(true);
            }}
            className="mt-1 border bg-white p-2"
          >
            <option value="rank">Manual order</option>
            <option value="updated">Recently updated</option>
            <option value="created">Recently added</option>
          </select>
        </div>
      </div>

      {notice !== null && (
        <p role="status" data-testid="board-notice" className="mt-4 border p-2 font-semibold">
          {notice}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="mt-4 font-semibold">
          Could not load the board: {error}
        </p>
      )}
      {loading && <p className="mt-4">Loading board…</p>}

      {board !== null && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          accessibility={{ announcements }}
          onDragStart={onDragStart}
          onDragEnd={(event) => void onDragEnd(event)}
          onDragCancel={() => setActiveId(null)}
        >
          <div className="mt-4 flex gap-3 overflow-x-auto pb-4" role="group" aria-label="Kanban columns">
            {board.columns.map((column) => (
              <BoardColumn
                key={column.status}
                status={column.status}
                total={column.total}
                cards={column.cards.slice(0, limitFor(column.status))}
                onOpen={setOpenJobId}
                onShowMore={(status) => void showMore(status)}
                loadingMore={loadingMore}
              />
            ))}
          </div>
          <DragOverlay>
            {activeCard === null ? null : (
              <div className="border bg-white p-3 font-semibold shadow-lg">
                {activeCard.title ?? "Untitled posting"}
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {openJobId !== null && (
        <CardDrawer
          jobId={openJobId}
          refreshToken={drawerToken}
          onClose={() => setOpenJobId(null)}
          onChanged={() => void refresh()}
          onCorrect={(card) => setDialog({ kind: "correct", card })}
          onApplied={(card, rank) => setDialog({ kind: "applied", card, rank })}
          onReject={(card, rank) => setDialog({ kind: "reject", card, rank })}
        />
      )}
      {dialog?.kind === "applied" && (
        <AppliedModal
          card={dialog.card}
          rank={dialog.rank}
          onClose={() => setDialog(null)}
          onSaved={onDialogSaved}
        />
      )}
      {dialog?.kind === "reject" && (
        <RejectDialog
          card={dialog.card}
          rank={dialog.rank}
          onClose={() => setDialog(null)}
          onSaved={onDialogSaved}
        />
      )}
      {dialog?.kind === "correct" && (
        <CorrectDialog
          card={dialog.card}
          onClose={() => setDialog(null)}
          onSaved={onDialogSaved}
        />
      )}
    </div>
  );
}
