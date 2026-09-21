import Link from "next/link";
import { Activity, ArrowRight, FileText, Kanban, PlusCircle } from "lucide-react";
import PlatformStatus from "@/components/PlatformStatus";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="home-page mx-auto flex min-h-0 w-full flex-col overflow-hidden px-4 pt-3.5 pb-6 sm:px-6 lg:px-8 scroll-mt-20 focus:outline-none space-y-4"
    >
      <PlatformStatus />

      {/* Primary Navigation & Action Hub */}
      <nav
        aria-label="Product"
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
      >
        <Card className="hover:border-primary/50 transition-all hover:shadow-xs flex flex-col justify-between border-border/80">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Kanban className="size-4" />
              </div>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                Workspace
              </span>
            </div>
            <CardTitle className="text-lg pt-1">
              <Link
                href="/board"
                className="hover:text-primary transition-colors hover:underline underline-offset-4"
              >
                Job board
              </Link>
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm leading-relaxed text-muted-foreground">
              Manage your job pipeline across five visual stages: New,
              Tailored, Applied, Interviewing, and Outcome. Drag and drop with
              real-time updates and keyboard accessibility.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <Button
              asChild
              className="w-full justify-between h-9 text-xs sm:text-sm shadow-xs"
              variant="default"
            >
              <Link href="/board">
                <span>Open Job Board</span>
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="hover:border-primary/50 transition-all hover:shadow-xs flex flex-col justify-between border-border/80">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <PlusCircle className="size-4" />
              </div>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                Ingestion
              </span>
            </div>
            <CardTitle className="text-lg pt-1">
              <Link
                href="/intake"
                className="hover:text-primary transition-colors hover:underline underline-offset-4"
              >
                Add job URLs
              </Link>
            </CardTitle>
            <CardDescription className="text-xs sm:text-sm leading-relaxed text-muted-foreground">
              Batch intake engine for job postings. Validate URLs client-side,
              drag-and-drop the browser bookmarklet, and dispatch automated
              scraping with Playwright Chromium.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <Button
              asChild
              className="w-full justify-between h-9 text-xs sm:text-sm shadow-xs"
              variant="outline"
            >
              <Link href="/intake">
                <span>Add Job URLs</span>
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </nav>

      {/* Secondary Hub: Master Resume and Full Health Diagnostics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
        <Link
          href="/master-resume"
          className="flex items-center justify-between rounded-xl border border-border bg-card/60 p-3.5 shadow-xs hover:border-primary/50 hover:bg-card transition-colors group"
        >
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <FileText className="size-4" aria-hidden="true" />
            </div>
            <div>
              <span className="text-xs font-semibold text-foreground block">
                Master Resume Facts
              </span>
              <span className="text-[11px] text-muted-foreground">
                Verified candidate facts, skills, and immutable profile
              </span>
            </div>
          </div>
          <ArrowRight className="size-4 text-muted-foreground group-hover:text-primary transition-colors" />
        </Link>

        <Link
          href="/health"
          className="flex items-center justify-between rounded-xl border border-border bg-card/60 p-3.5 shadow-xs hover:border-primary/50 hover:bg-card transition-colors group"
        >
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Activity className="size-4" aria-hidden="true" />
            </div>
            <div>
              <span className="text-xs font-semibold text-foreground block">
                API & System Health Diagnostics
              </span>
              <span className="text-[11px] text-muted-foreground">
                Live probe, SQLite WAL, migrations, and storage status
              </span>
            </div>
          </div>
          <ArrowRight className="size-4 text-muted-foreground group-hover:text-primary transition-colors" />
        </Link>
      </div>
    </main>
  );
}
