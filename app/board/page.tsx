import Board from "@/components/board/Board";
import { openRequestDatabase } from "@/app/api/_lib/request";
import { getBoardView, type BoardView } from "@/src/server/board";

/**
 * Request-time render: the initial board is read during navigation, never
 * prerendered at build (where no product database exists).
 */
export const dynamic = "force-dynamic";

/**
 * Best-effort server snapshot with safe defaults. Null when the database
 * is unavailable — the client then fetches as before and surfaces the
 * real error, so a cold start never 500s the page.
 */
async function loadInitialBoard(): Promise<BoardView | null> {
  try {
    const database = openRequestDatabase();
    if (!database.ok) {
      return null;
    }
    try {
      return getBoardView(database.handle, {});
    } finally {
      database.release();
    }
  } catch {
    return null;
  }
}

export default async function BoardPage() {
  const initialBoard = await loadInitialBoard();
  return (
    <main id="main-content" tabIndex={-1} className="board-page mx-auto flex h-full min-h-0 w-full flex-col gap-5 overflow-hidden px-4 py-5 sm:px-6 lg:px-8 scroll-mt-20 focus:outline-none">
      <div className="shrink-0 border-b border-border/60 pb-4">
        <h1 className="text-2xl font-bold tracking-tight">Job Board</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Drag cards between stages, or open a card to review resumes, inspect
          match facts, and record applications.
        </p>
      </div>

      <div className="min-h-0 flex-1">
        <Board initialData={initialBoard} />
      </div>
    </main>
  );
}
