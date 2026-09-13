import Link from "next/link";
import { ChevronRight, Home, PlusCircle } from "lucide-react";
import ClipperBookmarklet from "@/components/ClipperBookmarklet";
import IntakeForm from "@/components/IntakeForm";
import RecentBatches from "@/components/RecentBatches";

export default function IntakePage() {
  return (
    <main id="main-content" tabIndex={-1} className="mx-auto max-w-5xl px-4 sm:px-6 py-8 space-y-8 scroll-mt-20 focus:outline-none">
      {/* Breadcrumb & Header */}
      <div className="border-b border-border/60 pb-5">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5"
        >
          <Link
            href="/"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <Home className="h-3 w-3" />
            <span>Home</span>
          </Link>
          <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
          <span className="font-medium text-foreground">Intake</span>
        </nav>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <PlusCircle className="h-6 w-6 text-primary" />
              <span>Job Intake & Ingestion</span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Queue public job postings for automated extraction, scraping, and AI resume tailoring.
            </p>
          </div>

          <Link
            href="/board"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/80 bg-background px-3 py-1.5 text-xs font-semibold shadow-xs hover:bg-accent hover:text-accent-foreground transition-colors w-fit"
          >
            <span>View Job Board →</span>
          </Link>
        </div>
      </div>

      {/* Primary Intake Form */}
      <IntakeForm />

      {/* 1-Click Browser Clipper */}
      <ClipperBookmarklet />

      {/* Recent Batches History */}
      <RecentBatches />
    </main>
  );
}
