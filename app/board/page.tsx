import Link from "next/link";
import { ChevronRight, Home } from "lucide-react";
import Board from "@/components/board/Board";

export default function BoardPage() {
  return (
    <main className="mx-auto max-w-[1700px] w-full px-4 sm:px-6 py-6 space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border/60 pb-5">
        <div>
          <nav
            aria-label="Breadcrumb"
            className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1"
          >
            <Link
              href="/"
              className="flex items-center gap-1 hover:text-foreground transition-colors"
            >
              <Home className="h-3 w-3" />
              <span>Home</span>
            </Link>
            <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
            <span className="font-medium text-foreground">Board</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">Job Board</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Drag cards between stages, or open a card to review resumes, inspect
            match facts, and record applications.
          </p>
        </div>


      </div>

      <div>
        <Board />
      </div>
    </main>
  );
}
