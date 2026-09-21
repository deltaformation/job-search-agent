"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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
import { Notice, useNotice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import { apiPost, errorMessage } from "./api";
import SettingsModal, { type SettingsOpenRequest } from "./settings/SettingsModal";
import { OPEN_SETTINGS_EVENT, type OpenSettingsDetail } from "./settings/profiles";

export default function AppHeader() {
  const pathname = usePathname();
  const [addJobOpen, setAddJobOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequest, setSettingsRequest] = useState<SettingsOpenRequest | null>(null);
  const [quickUrl, setQuickUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Deep-link requests from other surfaces (e.g. drawer profile
  // readiness): open settings at the requested tab/profile.
  useEffect(() => {
    function onOpenSettings(event: Event): void {
      const detail = (event as CustomEvent<OpenSettingsDetail>).detail;
      if (detail === undefined || detail === null) {
        return;
      }
      setSettingsRequest((current) => ({
        tab: detail.tab,
        ...(detail.profileId === undefined ? {} : { profileId: detail.profileId }),
        seq: (current?.seq ?? 0) + 1,
      }));
      setSettingsOpen(true);
    }
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
    return () => {
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
    };
  }, []);
  const quickMessage = useNotice<{
    type: "success" | "error";
    text: string;
    batchId?: string;
  }>();

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
    quickMessage.clear();
    try {
      const res = await apiPost<{ batchId: string }>("/api/intake/submit", {
        lines: [quickUrl.trim()],
      });
      quickMessage.show({
        type: "success",
        text: "Job URL enqueued into batch!",
        batchId: res.batchId,
      });
      setQuickUrl("");
    } catch (err: unknown) {
      quickMessage.show({
        type: "error",
        text: errorMessage(err),
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/80 bg-background/95 backdrop-blur-md supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex min-h-16 w-full flex-wrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
        {/* Left: brand + primary navigation */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold tracking-tight transition-colors hover:text-primary"
            aria-label="Job Tracker Home"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-xs">
              <Briefcase className="size-4" aria-hidden="true" />
            </div>
            <span className="text-base font-semibold tracking-tight">Job Tracker</span>
          </Link>

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
                  <Icon className="size-4" aria-hidden="true" />
                  <span>{item.name}</span>
                </Link>
              );
            })}

            <Link
              href="/health"
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors hover:bg-muted hover:text-foreground",
                pathname === "/health"
                  ? "bg-secondary text-secondary-foreground shadow-xs font-semibold"
                  : "text-muted-foreground"
              )}
              title="System status: Ready · Click to view API health and diagnostics"
              aria-label="System status: Ready (view health diagnostics)"
            >
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              <span className="hidden md:inline text-[11px] font-medium">
                Ready
              </span>
            </Link>
          </nav>
        </div>

        {/* Right: profile + actions */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Active Profile Pill */}
          <div className="hidden xl:flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground">
            <UserCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <span className="font-medium text-foreground">Mouad Atfi</span>
            <span className="text-[11px] text-muted-foreground">·</span>
            <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
              Profile Active
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSettingsOpen(true)}
            className="h-8 gap-1 text-xs font-medium"
            aria-label="Open settings and data management"
          >
            <Settings className="size-3.5" aria-hidden="true" />
            <span>Settings</span>
          </Button>
          <Button
            size="sm"
            onClick={() => setAddJobOpen(true)}
            className="h-8 gap-1 text-xs font-medium"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            <span>Add Job</span>
          </Button>
        </div>
      </div>

      {/* Quick Add Job URL Dialog */}
      <Dialog open={addJobOpen} onOpenChange={setAddJobOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="size-5 text-primary" aria-hidden="true" />
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

            {quickMessage.notice !== null && (
              <Notice
                key={quickMessage.notice.seq}
                variant={quickMessage.notice.data.type}
                onDismiss={quickMessage.clear}
                className={cn(
                  "rounded-md p-3 text-xs",
                  quickMessage.notice.data.type === "success"
                    ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300"
                    : "bg-destructive/10 text-destructive"
                )}
              >
                <p className="font-medium">{quickMessage.notice.data.text}</p>
                {quickMessage.notice.data.batchId && (
                  <Link
                    href={`/intake/batches/${quickMessage.notice.data.batchId}`}
                    onClick={() => setAddJobOpen(false)}
                    className="mt-1 inline-flex items-center gap-1 font-semibold underline underline-offset-2"
                  >
                    View Batch Progress <ExternalLink className="size-3.5" aria-hidden="true" />
                  </Link>
                )}
              </Notice>
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
      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} openRequest={settingsRequest} />
    </header>
  );
}
