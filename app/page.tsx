import Link from "next/link";
import { ArrowRight, Kanban, PlusCircle } from "lucide-react";
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
    <main className="mx-auto max-w-5xl px-4 sm:px-6 py-10 space-y-8">
      <a
        href="#platform-status"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-foreground focus:ring-2 focus:ring-ring focus:shadow-md"
      >
        Skip to platform status
      </a>

      <PlatformStatus />

      {/* Primary Navigation & Action Hub */}
      <nav
        aria-label="Product"
        className="grid grid-cols-1 md:grid-cols-2 gap-6"
      >
        <Card className="hover:border-primary/50 transition-all hover:shadow-md flex flex-col justify-between">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Kanban className="h-5 w-5" />
              </div>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                Workspace
              </span>
            </div>
            <CardTitle className="text-xl pt-2">
              <Link
                href="/board"
                className="hover:text-primary transition-colors underline underline-offset-4"
              >
                Job board
              </Link>
            </CardTitle>
            <CardDescription className="text-sm leading-relaxed">
              Manage your job pipeline across five visual stages: New,
              Tailored, Applied, Interviewing, and Outcome. Drag and drop with
              real-time updates and keyboard accessibility.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <Button
              asChild
              className="w-full justify-between"
              variant="default"
            >
              <Link href="/board">
                <span>Open Job Board</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="hover:border-primary/50 transition-all hover:shadow-md flex flex-col justify-between">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <PlusCircle className="h-5 w-5" />
              </div>
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                Ingestion
              </span>
            </div>
            <CardTitle className="text-xl pt-2">
              <Link
                href="/intake"
                className="hover:text-primary transition-colors underline underline-offset-4"
              >
                Add job URLs
              </Link>
            </CardTitle>
            <CardDescription className="text-sm leading-relaxed">
              Batch intake engine for job postings. Validate URLs client-side,
              drag-and-drop the browser bookmarklet, and dispatch automated
              scraping with Playwright Chromium.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-0">
            <Button
              asChild
              className="w-full justify-between"
              variant="outline"
            >
              <Link href="/intake">
                <span>Add Job URLs</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </nav>
    </main>
  );
}
