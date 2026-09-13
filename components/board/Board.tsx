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
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardStatus } from "@/src/domain/enums";
import type { BoardCardView, BoardView } from "@/src/server/board";
import { Notice, useNotice, type NoticeVariant } from "../ui/notice";
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

export default function Board({ initialData = null }: { initialData?: BoardView | null }) {
  const [board, setBoard] = useState<BoardView | null>(initialData);
  const [loading, setLoading] = useState(initialData === null);
  const [error, setError] = useState<string | null>(null);
  const boardNotice = useNotice<{ variant: NoticeVariant; text: string }>();
  const [query, setQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [viewMode, setViewMode] = useState<"kanban" | "stacked">("kanban");
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

  // Heavy synchronous renders (drawer mount, full-column re-layout) run as
  // transitions so the click paints first and the tree follows. Stable
  // references keep memoized cards from re-rendering on unrelated updates.
  const handleOpenJob = useCallback((jobId: string) => {
    startTransition(() => setOpenJobId(jobId));
  }, []);
  const handleCloseJob = useCallback(() => {
    startTransition(() => setOpenJobId(null));
  }, []);
  const handleViewMode = useCallback((mode: "kanban" | "stacked") => {
    startTransition(() => setViewMode(mode));
  }, []);

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

  const anyTailoringRunning =
    board !== null &&
    board.columns.some((column) => column.cards.some((card) => card.tailoringState === "RUNNING"));

  useEffect(() => {
    // While any visible card has a run in flight, re-read the board every
    // 3s so badges flip to review/failed states on their own. Queued
    // (PENDING) cards do not poll: with a manual queue runner they can sit
    // indefinitely, and polling them would never settle.
    if (!anyTailoringRunning) {
      return;
    }
    const timer = setInterval(() => {
      void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [anyTailoringRunning, refresh]);

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
      boardNotice.show({ variant: "error", text: `Update failed: ${errorMessage(error)}` });
      await refresh();
      return false;
    }
    boardNotice.show({ variant: "success", text: successNotice });
    await refresh();
    return true;
  }

  function onDragStart(event: DragStartEvent): void {
    setActiveId(String(event.active.id));
    boardNotice.clear();
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
      boardNotice.show({
        variant: "error",
        text: "TAILORED requires an approved resume — approval moves the card, not dragging.",
      });
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 flex flex-wrap items-end gap-3 rounded-lg border border-border/70 bg-card p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label="Board view" className="flex rounded-lg bg-muted p-1">
            {(["kanban", "stacked"] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={viewMode === mode}
                onClick={() => handleViewMode(mode)}
                className={`rounded-md px-3 py-2 text-sm transition-opacity duration-150 ${viewMode === mode ? "bg-background shadow-sm" : "text-muted-foreground"}`}>
                {mode === "kanban" ? "Kanban" : "Stacked"}
              </button>
            ))}
          </div>
          {board && <p className="font-mono tabular-nums text-xs text-muted-foreground">
            {committedQuery ? "Matching active" : "Active"}: {board.columns.filter((c) => c.status !== "REJECTED").reduce((n, c) => n + c.total, 0)} jobs · {board.columns.flatMap((c) => c.cards).filter((c) => c.resume?.reviewState === "AWAITING_REVIEW").length} awaiting review in loaded cards
          </p>}
        </div>
        <div className="flex-1 min-w-48">
          <label htmlFor="board-search" className="block text-xs font-semibold text-muted-foreground mb-1">
            Search cards
          </label>
          <input
            id="board-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Title, company, or location…"
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label htmlFor="board-sort" className="block text-xs font-semibold text-muted-foreground mb-1">
            Sort
          </label>
          <select
            id="board-sort"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as BoardSort);
              setLoading(true);
            }}
            className="rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
          >
            <option value="rank">Manual order</option>
            <option value="updated">Recently updated</option>
            <option value="created">Recently added</option>
          </select>
        </div>
      </div>

      {boardNotice.notice !== null && (
        <Notice
          key={boardNotice.notice.seq}
          variant={boardNotice.notice.data.variant}
          onDismiss={boardNotice.clear}
          testId="board-notice"
          className={
            boardNotice.notice.data.variant === "success"
              ? "shrink-0 mt-3 rounded-md border border-primary/20 bg-primary/5 p-3 text-sm font-semibold text-primary"
              : "shrink-0 mt-3 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm font-semibold text-destructive"
          }
        >
          {boardNotice.notice.data.text}
        </Notice>
      )}
      {error !== null && (
        <Notice
          variant="error"
          onDismiss={() => setError(null)}
          className="shrink-0 mt-3 rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm font-semibold text-destructive"
        >
          Could not load the board: {error}
        </Notice>
      )}
      {loading && <p className="mt-3 text-sm text-muted-foreground">Loading board…</p>}

      {board !== null && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          accessibility={{ announcements }}
          onDragStart={onDragStart}
          onDragEnd={(event) => void onDragEnd(event)}
          onDragCancel={() => setActiveId(null)}
        >
          <div className={`board-canvas mt-5 flex min-h-0 flex-1 gap-4 overflow-x-auto overflow-y-hidden pb-4 ${viewMode === "stacked" ? "board-stacked flex-col" : ""}`} role="group" aria-label="Kanban columns">
            {board.columns.map((column) => (
              <BoardColumn
                key={column.status}
                status={column.status}
                total={column.total}
                cards={column.cards.slice(0, limitFor(column.status))}
                onOpen={handleOpenJob}
                onShowMore={(status) => void showMore(status)}
                loadingMore={loadingMore}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}>
            {activeCard === null ? null : (
              <div className="w-[280px] rotate-[1.5deg] rounded-xl border border-primary/40 bg-card p-3.5 opacity-90 shadow-xl ring-2 ring-primary ring-offset-2">
                <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {activeCard.company ?? "Unknown Company"}
                </p>
                <p className="mt-1 line-clamp-2 text-sm font-semibold text-foreground">
                  {activeCard.title ?? "Untitled posting"}
                </p>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {openJobId !== null && (
        <CardDrawer
          key={openJobId}
          jobId={openJobId}
          refreshToken={drawerToken}
          onClose={handleCloseJob}
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
