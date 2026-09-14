import Link from "next/link";
import { ArrowRight, PlusCircle } from "lucide-react";
import ClipperBookmarklet from "@/components/ClipperBookmarklet";
import IntakeForm from "@/components/IntakeForm";
import RecentBatches from "@/components/RecentBatches";

export default function IntakePage() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="intake-page mx-auto flex min-h-0 w-full flex-col overflow-hidden px-4 pt-3.5 pb-6 sm:px-6 lg:px-8 scroll-mt-20 focus:outline-none"
    >
      {/* Top Header & Navigation Bar (matches Board page toolbar) */}
      <div className="shrink-0 mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between rounded-xl border border-border/70 bg-card/60 p-2.5 sm:px-3.5 shadow-xs backdrop-blur-xs">
        {/* Left: Title + Status Badge */}
        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
          <h1 className="text-lg sm:text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <PlusCircle className="size-5 text-primary" aria-hidden="true" />
            <span>Job Intake</span>
          </h1>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary/80 px-2.5 py-0.5 text-xs font-medium text-secondary-foreground border border-border/60">
              <span className="size-1.5 rounded-full bg-primary" />
              <span>Batch URL Ingestion & Clipper</span>
            </span>
          </div>
        </div>

        {/* Right: Quick Action to Board */}
        <div className="flex items-center gap-2">
          <Link
            href="/board"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-background/90 px-3 text-xs sm:text-sm font-medium text-foreground shadow-xs hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <span>View Board</span>
            <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </Link>
        </div>
      </div>

      {/* Main Grid: Responsive 2-column workspace */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 min-h-0">
        {/* Primary Ingestion Column */}
        <div className="space-y-4 lg:col-span-7 xl:col-span-8">
          <IntakeForm />
          <RecentBatches />
        </div>

        {/* Side Panel: 1-Click Browser Clipper & Extension Setup */}
        <div className="space-y-4 lg:col-span-5 xl:col-span-4">
          <ClipperBookmarklet />
        </div>
      </div>
    </main>
  );
}
