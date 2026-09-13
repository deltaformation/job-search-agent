import Link from "next/link";
import { ChevronRight, Home } from "lucide-react";
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
      <div className="shrink-0 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border/60 pb-5">
        <div>
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1"
          >
            <Link
              href="/"
              className="flex items-center gap-1 hover:text-foreground transition-colors"
            >
              <Home className="size-3.5" aria-hidden="true" />
              <span>Home</span>
            </Link>
            <ChevronRight className="size-3.5 text-muted-foreground/60" aria-hidden="true" />
            <span className="font-medium text-foreground">Board</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">Job Board</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Drag cards between stages, or open a card to review resumes, inspect
            match facts, and record applications.
          </p>
        </div>


      </div>

      <div className="min-h-0 flex-1">
        <Board initialData={initialBoard} />
      </div>
    </main>
  );
}
