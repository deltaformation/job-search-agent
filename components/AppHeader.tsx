"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Briefcase,
  ExternalLink,
  Kanban,
  Plus,
  Settings,
  Sparkles,
  UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { apiPost, errorMessage } from "./api";
import SettingsModal from "./settings/SettingsModal";

export default function AppHeader() {
  const pathname = usePathname();
  const [addJobOpen, setAddJobOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [quickUrl, setQuickUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [quickMessage, setQuickMessage] = useState<{
    type: "success" | "error";
    text: string;
    batchId?: string;
  } | null>(null);

  const navItems = [
    {
      name: "Board",
      href: "/board",
      icon: Kanban,
      active: pathname === "/board" || pathname?.startsWith("/board/"),
    },
    {
      name: "Intake",
      href: "/intake",
      icon: Plus,
      active: pathname === "/intake" || pathname?.startsWith("/intake/"),
    },
  ];

  async function handleQuickSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!quickUrl.trim()) return;
    setSubmitting(true);
    setQuickMessage(null);
    try {
      const res = await apiPost<{ batchId: string }>("/api/intake/submit", {
        lines: [quickUrl.trim()],
      });
      setQuickMessage({
        type: "success",
        text: "Job URL enqueued into batch!",
        batchId: res.batchId,
      });
      setQuickUrl("");
    } catch (err: unknown) {
      setQuickMessage({
        type: "error",
        text: errorMessage(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/80 bg-background/95 backdrop-blur-md supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex min-h-16 flex-wrap gap-2 py-3 max-w-[1700px] items-center justify-between px-4 sm:px-6">
        {/* Brand and Profile */}
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold tracking-tight transition-colors hover:text-primary"
            aria-label="Job Tracker Home"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-xs">
              <Briefcase className="h-4 w-4" />
            </div>
            <span className="text-base font-bold">Job Tracker</span>
          </Link>

          {/* Active Profile Pill */}
          <div className="hidden sm:flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground">
            <UserCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span className="font-medium text-foreground">Mouad Atfi</span>
            <span className="text-[10px] text-muted-foreground">·</span>
            <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
              Profile Active
            </span>
          </div>
        </div>

        {/* Center Navigation */}
        <nav className="flex items-center gap-1 sm:gap-2" aria-label="Main Navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors",
                  item.active
                    ? "bg-secondary text-secondary-foreground shadow-xs font-semibold"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                aria-current={item.active ? "page" : undefined}
              >
                <Icon className="h-4 w-4" />
                <span>{item.name}</span>
              </Link>
            );
          })}

          <div
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground"
            title="Local system running"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="hidden md:inline text-[11px] font-medium text-muted-foreground">
              Ready
            </span>
          </div>
        </nav>

        {/* Direct Action */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSettingsOpen(true)}
            className="h-8 gap-1 text-xs font-medium"
            aria-label="Open settings and data management"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Settings</span>
          </Button>
          <Button
            size="sm"
            onClick={() => setAddJobOpen(true)}
            className="h-8 gap-1 text-xs font-medium"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Job</span>
          </Button>
        </div>
      </div>

      {/* Quick Add Job URL Dialog */}
      <Dialog open={addJobOpen} onOpenChange={setAddJobOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Quick Add Job URL
            </DialogTitle>
            <DialogDescription>
              Paste a public job posting URL to queue scraping and resume tailoring.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleQuickSubmit} className="space-y-4 pt-2">
            <div>
              <label
                htmlFor="quick-add-url-input"
                className="text-xs font-semibold text-muted-foreground"
              >
                Job Posting URL
              </label>
              <input
                id="quick-add-url-input"
                type="url"
                required
                placeholder="https://jobs.example.com/posting/12345"
                value={quickUrl}
                onChange={(e) => setQuickUrl(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            {quickMessage && (
              <div
                className={cn(
                  "rounded-md p-3 text-xs",
                  quickMessage.type === "success"
                    ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300"
                    : "bg-destructive/10 text-destructive"
                )}
              >
                <p className="font-medium">{quickMessage.text}</p>
                {quickMessage.batchId && (
                  <Link
                    href={`/intake/batches/${quickMessage.batchId}`}
                    onClick={() => setAddJobOpen(false)}
                    className="mt-1 inline-flex items-center gap-1 font-semibold underline underline-offset-2"
                  >
                    View Batch Progress <ExternalLink className="h-3 w-3" />
                  </Link>
                )}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <Link
                href="/intake"
                onClick={() => setAddJobOpen(false)}
                className="text-xs text-muted-foreground underline-offset-4 hover:underline"
              >
                Open full batch intake →
              </Link>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAddJobOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={submitting || !quickUrl.trim()}
                >
                  {submitting ? "Queueing…" : "Queue Job"}
                </Button>
              </div>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Settings & Data Management */}
      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </header>
  );
}
