"use client";

import { useEffect, useRef, useState } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Notice, useNotice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";
import { apiGet, apiPost, errorMessage } from "../api";
import CopyProfileForm from "./CopyProfileForm";
import ProfileWorkspace from "./ProfileWorkspace";
import { profileReadiness, type SettingsProfileSummary } from "./profiles";

/**
 * Settings and data-management modal (R5-A, profile onboarding C):
 * backup download, archive restore, board reset, AI provider + model
 * chains, connection diagnostics, per-profile career setup with
 * master review/activation, legacy-file re-sync, and storage stats.
 * API keys are write-only: the form accepts new values for saving or
 * transient testing, and the server returns per-provider fingerprints
 * only — key values are never fetched or displayed.
 */

type AiProviderId = "openrouter" | "google" | "meta";

interface ProviderSnapshot {
  configured: boolean;
  fingerprint: string | null;
  models: { primary: string; fallback: string };
}

interface WorkerProviderStatus {
  workerId: string;
  startedAt: string;
  provider: AiProviderId;
  models: { primary: string; fallback: string };
  keyConfigured: boolean;
  tailorConfigured: boolean;
}

interface SettingsSnapshot {
  models: { primary: string; fallback: string };
  activeProvider: AiProviderId;
  providers: Record<AiProviderId, ProviderSnapshot>;
  /** Saved file state; absent only in legacy test fixtures. */
  saved?: { exists: boolean; provider: AiProviderId; providers: Record<AiProviderId, ProviderSnapshot> };
  savedProvider?: AiProviderId;
  restartNeeded?: boolean;
  restartDetail?: string | null;
  worker?: WorkerProviderStatus | null;
  workerMatch?: boolean | null;
  openRouter: { configured: boolean; fingerprint: string | null };
  profile: {
    activeVersion: number;
    activeVersionAt: string;
    displayName: string | null;
    approvedFacts: number;
    verifiedSkills: number;
  } | null;
  storage: {
    databaseBytes: number;
    walBytes: number;
    jobCount: number;
    evidenceBytes: number;
    evidenceFiles: number;
    artifactBytes: number;
    artifactFiles: number;
    backupCount: number;
    backupsBytes: number;
  };
}

interface AiTestModelResult {
  ok: boolean;
  model: string;
  latencyMs: number;
  error: string | null;
  reasonCode?: string;
  action?: string | null;
}

interface AiTestResult {
  ok: boolean;
  model: string | null;
  latencyMs: number;
  error: string | null;
  provider?: AiProviderId;
  testedModel?: string;
  keySource?: "stored" | "transient";
  reasonCode?: string;
  action?: string | null;
  fallback?: AiTestModelResult | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

const AI_PROVIDERS: Array<{
  id: AiProviderId;
  name: string;
  keyName: string;
  primaryPlaceholder: string;
  fallbackPlaceholder: string;
}> = [
  {
    id: "openrouter",
    name: "OpenRouter",
    keyName: "OPENROUTER_API_KEY",
    primaryPlaceholder: "google/gemma-4-26b-a4b-it:free",
    fallbackPlaceholder: "nvidia/nemotron-3.5-lightning:free",
  },
  {
    id: "google",
    name: "Google AI Studio",
    keyName: "GEMINI_API_KEY",
    primaryPlaceholder: "gemini-2.5-pro",
    fallbackPlaceholder: "gemini-2.5-flash",
  },
  {
    id: "meta",
    name: "Meta Muse",
    keyName: "META_API_KEY",
    primaryPlaceholder: "meta-muse",
    fallbackPlaceholder: "(optional second model)",
  },
];

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="text-base font-semibold tracking-tight text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}
/**
 * Draft baseline is the SAVED configuration, not the running one: after
 * saving OpenRouter while Google is still active, refresh/reopen keeps
 * the OpenRouter draft instead of silently reverting the form to
 * Google. Pure of its argument; module scope keeps the settings effect
 * lint-stable.
 */
function draftsFromSaved(data: SettingsSnapshot): {
  provider: AiProviderId;
  primary: string;
  fallback: string;
} {
  const provider = data.savedProvider ?? data.saved?.provider ?? data.activeProvider ?? "openrouter";
  const chain =
    data.saved?.providers?.[provider]?.models ?? data.providers?.[provider]?.models;
  return {
    provider,
    primary: chain?.primary ?? data.models.primary,
    fallback: chain?.fallback ?? data.models.fallback,
  };
}

export interface SettingsOpenRequest {
  tab: "data" | "ai" | "profile";
  profileId?: string;
  /** Bumped per request so repeats re-apply while open. */
  seq: number;
}

export default function SettingsModal({
  open,
  onOpenChange,
  openRequest,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openRequest?: SettingsOpenRequest | null;
}) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const settingsNotice = useNotice<{ type: "success" | "error"; text: string }>();
  const [selectedProvider, setSelectedProvider] = useState<AiProviderId>("openrouter");
  const [primary, setPrimary] = useState("");
  const [fallback, setFallback] = useState("");
  /** Transient key draft: tested without saving, blank retains stored. */
  const [apiKey, setApiKey] = useState("");
  const [aiResult, setAiResult] = useState<AiTestResult | null>(null);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");
  const [dataSwapped, setDataSwapped] = useState(false);
  const [profiles, setProfiles] = useState<SettingsProfileSummary[] | null>(null);
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [tab, setTab] = useState("data");
  /** null = list only; "empty"/"copy" = creation form. */
  const [creationMode, setCreationMode] = useState<"empty" | "copy" | null>(null);
  const [emptyName, setEmptyName] = useState("");
  const [emptyDisplayName, setEmptyDisplayName] = useState("");
  /** Profile id whose setup workspace is open (independent of default). */
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<string | null>(null);
  /** Bumped to refetch one workspace's version history after writes. */
  const [versionsTick, setVersionsTick] = useState(0);
  const [workspaceResetKey, setWorkspaceResetKey] = useState(0);
  const appliedRequestSeq = useRef(0);
  const sectionScrollRef = useRef<HTMLDivElement>(null);

  function onSectionChange(next: string): void {
    setTab(next);
    // Section switches start at the top: without a reset, the newly
    // shown panel inherits the previous scroll offset and opens
    // mid-section. Instant (not smooth): tab swaps are state changes.
    if (sectionScrollRef.current !== null) {
      sectionScrollRef.current.scrollTop = 0;
    }
  }

  /**
   * Drafts reset only on first load and after provider saves —
   * unrelated refreshes (backup, profiles) preserve entered input.
   */
  function applySnapshot(data: SettingsSnapshot, resetDrafts: boolean): void {
    setSnapshot(data);
    if (resetDrafts) {
      const drafts = draftsFromSaved(data);
      setSelectedProvider(drafts.provider);
      setPrimary(drafts.primary);
      setFallback(drafts.fallback);
      setApiKey("");
      setAiResult(null);
      setRemoveArmed(false);
    }
  }

  async function refresh(): Promise<void> {
    setLoadError(null);
    try {
      applySnapshot(await apiGet<SettingsSnapshot>("/api/settings"), snapshot === null);
    } catch (error: unknown) {
      setLoadError(errorMessage(error));
    }
  }

  /** Refresh after a provider save: reload saved state into the drafts. */
  async function refreshAi(): Promise<void> {
    setLoadError(null);
    try {
      applySnapshot(await apiGet<SettingsSnapshot>("/api/settings"), true);
    } catch (error: unknown) {
      setLoadError(errorMessage(error));
    }
  }

  async function refreshProfiles(): Promise<void> {
    setProfilesError(null);
    try {
      const data = await apiGet<{ profiles: SettingsProfileSummary[] }>("/api/settings/profiles");
      setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
    } catch (error: unknown) {
      setProfilesError(errorMessage(error));
    }
  }

  /** Profiles changed under a workspace: refresh list + version history. */
  async function profilesChanged(): Promise<void> {
    await refreshProfiles();
    setVersionsTick((tick) => tick + 1);
  }

  function selectProvider(provider: AiProviderId): void {
    setSelectedProvider(provider);
    setAiResult(null);
    setApiKey("");
    setRemoveArmed(false);
    const chain =
      snapshot?.saved?.providers?.[provider]?.models ?? snapshot?.providers?.[provider]?.models;
    if (chain !== undefined) {
      setPrimary(chain.primary);
      setFallback(chain.fallback);
    }
  }

  /** Any tested-input edit invalidates the previous test result. */
  function editPrimary(value: string): void {
    setPrimary(value);
    setAiResult(null);
  }

  function editFallback(value: string): void {
    setFallback(value);
    setAiResult(null);
  }

  function editApiKey(value: string): void {
    setApiKey(value);
    setAiResult(null);
  }

  function handleOpenChange(next: boolean): void {
    if (!next) {
      // Reset on close (an event handler, not an effect) so every
      // opening starts fresh without setState-in-effect.
      setSnapshot(null);
      settingsNotice.clear();
      setAiResult(null);
      setApiKey("");
      setRemoveArmed(false);
      setResetArmed(false);
      setResetConfirm("");
      setDataSwapped(false);
      setLoadError(null);
      setProfiles(null);
      setProfilesError(null);
      setTab("data");
      setCreationMode(null);
      setEmptyName("");
      setEmptyDisplayName("");
      setWorkspaceId(null);
      setWorkspaceDirty(false);
      setPendingWorkspaceId(null);
      appliedRequestSeq.current = 0;
    }
    onOpenChange(next);
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    let cancelled = false;
    apiGet<SettingsSnapshot>("/api/settings").then(
      (data) => {
        if (cancelled) {
          return;
        }
        applySnapshot(data, true);
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoadError(errorMessage(error));
        }
      },
    );
    apiGet<{ profiles: SettingsProfileSummary[] }>("/api/settings/profiles").then(
      (data) => {
        if (!cancelled) {
          setProfiles(Array.isArray(data.profiles) ? data.profiles : []);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setProfilesError(errorMessage(error));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open ]);

  // Deep-link requests (e.g. drawer "set up this profile"): switch tab
  // and open the exact profile workspace, guarded like a manual
  // switch when the current workspace holds unsaved edits.
  useEffect(() => {
    if (!open || openRequest === undefined || openRequest === null) {
      return;
    }
    if (openRequest.seq <= appliedRequestSeq.current) {
      return;
    }
    appliedRequestSeq.current = openRequest.seq;
    onSectionChange(openRequest.tab);
    if (openRequest.profileId !== undefined) {
      requestWorkspace(openRequest.profileId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openRequest?.seq]);

  /** Open a workspace, or stage a discard-guard when dirty. */
  function requestWorkspace(nextId: string | null): void {
    if (workspaceDirty && nextId !== workspaceId) {
      setPendingWorkspaceId(nextId);
      return;
    }
    setWorkspaceId(nextId);
    setWorkspaceDirty(false);
    setPendingWorkspaceId(null);
  }

  function confirmWorkspaceSwitch(): void {
    setWorkspaceId(pendingWorkspaceId);
    setWorkspaceDirty(false);
    setPendingWorkspaceId(null);
    // Remount the workspace so discarded drafts truly clear.
    setWorkspaceResetKey((key) => key + 1);
  }

  async function run(action: string, fn: () => Promise<string>): Promise<void> {
    setBusy(action);
    settingsNotice.clear();
    try {
      settingsNotice.show({ type: "success", text: await fn() });
    } catch (error: unknown) {
      settingsNotice.show({ type: "error", text: errorMessage(error) });
    } finally {
      setBusy(null);
    }
  }

  async function downloadBackup(): Promise<void> {
    await run("backup", async () => {
      const response = await fetch("/api/backup", { method: "GET" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
          reason?: string;
        } | null;
        throw new Error(
          body?.reason ?? body?.error ?? `backup failed (${response.status})`,
        );
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? "job-tracker-backup.tar.gz";
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      await refresh();
      return `Backup downloaded: ${filename}`;
    });
  }

  async function uploadRestore(file: File): Promise<void> {
    await run("restore", async () => {
      const form = new FormData();
      form.append("archive", file, file.name);
      const response = await fetch("/api/restore", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as {
        jobs?: number;
        preRestoreBackup?: string;
        error?: string;
        reason?: string;
      } | null;
      if (!response.ok) {
        throw new Error(body?.reason ?? body?.error ?? `restore failed (${response.status})`);
      }
      setDataSwapped(true);
      await refresh();
      return `Restored ${body?.jobs ?? "?"} jobs. Rollback backup: ${body?.preRestoreBackup ?? "?"}. Reload the app to see restored data.`;
    });
  }

  async function submitReset(): Promise<void> {
    await run("reset", async () => {
      const body = await apiPost<{
        deletedJobs: number;
        preResetBackup: string;
        preservedProfile: boolean;
      }>("/api/jobs/reset", { confirm: "RESET" });
      setDataSwapped(true);
      setResetArmed(false);
      setResetConfirm("");
      await refresh();
      return `Board cleared (${body.deletedJobs} jobs removed). Safety backup: ${body.preResetBackup}. Reload the app to see the empty board.`;
    });
  }

  async function switchModelChain(): Promise<void> {
    await run("models", async () => {
      const trimmedPrimary = primary.trim();
      const trimmedFallback = fallback.trim();
      if (trimmedPrimary === "" || trimmedFallback === "") {
        throw new Error("Primary and fallback models are required to save.");
      }
      const payload: Record<string, string> =
        selectedProvider === "google"
          ? {
              provider: selectedProvider,
              googleModel: trimmedPrimary,
              googleFallbackModel: trimmedFallback,
            }
          : selectedProvider === "meta"
            ? {
                provider: selectedProvider,
                metaModel: trimmedPrimary,
                metaFallbackModel: trimmedFallback,
              }
            : { provider: selectedProvider, primary: trimmedPrimary, fallback: trimmedFallback };
      const body = await apiPost<{
        primary: string;
        fallback: string;
        savedProvider: AiProviderId;
        restartRequired: boolean;
      }>("/api/settings/model", payload);
      await refreshAi();
      const savedName = AI_PROVIDERS.find((item) => item.id === body.savedProvider)?.name ?? body.savedProvider;
      return `${savedName} saved (${body.primary} / ${body.fallback}). Restart the app to activate it.`;
    });
  }

  async function saveApiKey(): Promise<void> {
    await run("key-save", async () => {
      const body = await apiPost<{ configured: boolean; message: string }>(
        "/api/settings/keys",
        { provider: selectedProvider, key: apiKey },
      );
      setApiKey("");
      await refreshAi();
      return body.message;
    });
  }

  async function removeApiKey(): Promise<void> {
    if (!removeArmed) {
      setRemoveArmed(true);
      return;
    }
    await run("key-remove", async () => {
      const body = await apiPost<{ configured: boolean; message: string }>(
        "/api/settings/keys",
        { provider: selectedProvider, remove: true },
      );
      setRemoveArmed(false);
      setApiKey("");
      await refreshAi();
      return body.message;
    });
  }

  async function testAi(): Promise<void> {
    await run("ai-test", async () => {
      const payload: Record<string, string> = { provider: selectedProvider };
      if (primary.trim() !== "") {
        payload["model"] = primary.trim();
      }
      if (fallback.trim() !== "" && fallback.trim() !== primary.trim()) {
        payload["fallbackModel"] = fallback.trim();
      }
      if (apiKey.trim() !== "") {
        payload["apiKey"] = apiKey;
      }
      const result = await apiPost<AiTestResult>("/api/settings/ai-test", payload);
      setAiResult(result);
      const tested = result.testedModel ?? result.model ?? primary.trim();
      if (result.ok) {
        const fallbackNote =
          result.fallback === null || result.fallback === undefined
            ? ""
            : `; fallback ${result.fallback.model} passed in ${result.fallback.latencyMs} ms`;
        return `Test passed: ${tested} in ${result.latencyMs} ms${fallbackNote} (${result.keySource === "transient" ? "entered" : "stored"} key, nothing saved).`;
      }
      return `Test failed: ${result.error ?? "unknown error"}`;
    });
  }

  async function resyncProfile(): Promise<void> {
    await run("resync", async () => {
      const body = await apiPost<{
        ok: boolean;
        versionId: string;
        version: number;
        alreadyCurrent: boolean;
      }>("/api/settings/resync", {});
      await refresh();
      await refreshProfiles();
      return body.alreadyCurrent
        ? `Profile already current (version ${body.version}).`
        : `Profile re-synced to version ${body.version}.`;
    });
  }

  async function setDefaultProfile(id: string, name: string): Promise<void> {
    await run("profile-default", async () => {
      await apiPost(`/api/settings/profiles/${id}/set-default`, {});
      await refresh();
      await refreshProfiles();
      return `Default career profile is now “${name}”.`;
    });
  }

  /** Start-empty creation: identity shell only; setup continues below. */
  async function createEmptyProfile(): Promise<void> {
    await run("profile-create", async () => {
      const created = await apiPost<{ profile: SettingsProfileSummary }>(
        "/api/settings/profiles",
        { name: emptyName.trim(), displayName: emptyDisplayName.trim() },
      );
      setCreationMode(null);
      setEmptyName("");
      setEmptyDisplayName("");
      await refreshProfiles();
      setWorkspaceId(created.profile.id);
      setWorkspaceDirty(false);
      return `Career profile “${created.profile.displayName}” created empty — set up its preferences and master below.`;
    });
  }

  const storage = snapshot?.storage ?? null;
  const workspaceProfile =
    workspaceId === null ? null : (profiles?.find((entry) => entry.id === workspaceId) ?? null);
  const workerStatus = snapshot?.worker ?? null;
  const workerName =
    workerStatus === null
      ? null
      : (AI_PROVIDERS.find((item) => item.id === workerStatus.provider)?.name ?? workerStatus.provider);
  const savedProviderId = snapshot?.savedProvider ?? snapshot?.saved?.provider ?? null;
  const savedName =
    savedProviderId === null
      ? "Saved configuration"
      : (AI_PROVIDERS.find((item) => item.id === savedProviderId)?.name ?? savedProviderId);
  const runningName =
    snapshot === null
      ? null
      : (AI_PROVIDERS.find((item) => item.id === snapshot.activeProvider)?.name ?? snapshot.activeProvider);
  const selectedName =
    AI_PROVIDERS.find((item) => item.id === selectedProvider)?.name ?? selectedProvider;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="settings-panel flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon className="size-5 text-primary" aria-hidden="true" />
            Settings & Data Management
          </DialogTitle>
          <DialogDescription>
            Backups, restore, board reset, AI models, profile, and storage.
          </DialogDescription>
        </DialogHeader>

        {loadError !== null && (
          <Notice
            variant="error"
            onDismiss={() => setLoadError(null)}
            className="rounded-md bg-destructive/10 p-3 text-xs text-destructive"
          >
            Could not load settings: {loadError}
          </Notice>
        )}

        {settingsNotice.notice !== null && (
          <Notice
            key={settingsNotice.notice.seq}
            variant={settingsNotice.notice.data.type}
            onDismiss={settingsNotice.clear}
            className={cn(
              "rounded-md p-3 text-xs",
              settingsNotice.notice.data.type === "success"
                ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300"
                : "bg-destructive/10 text-destructive",
            )}
          >
            {settingsNotice.notice.data.text}
          </Notice>
        )}

        {dataSwapped && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <span>The database was replaced. Reload the app to see current data.</span>
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              Reload app
            </Button>
          </div>
        )}

        <Tabs value={tab} onValueChange={onSectionChange} className="flex min-h-0 flex-1 flex-col gap-5">
          <TabsList aria-label="Settings sections" className="h-auto shrink-0 flex-wrap justify-start gap-1">
            <TabsTrigger value="data">Data & Backup</TabsTrigger>
            <TabsTrigger value="ai">AI & Models</TabsTrigger>
            <TabsTrigger value="profile">Candidate Profile</TabsTrigger>
          </TabsList>
          <div ref={sectionScrollRef} className="settings-scroll min-h-0 flex-1 overflow-y-auto">
            <TabsContent value="data" className="workspace-tab mt-0 min-h-[400px] space-y-6">
          <Section title="Backup & Restore">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void downloadBackup()} disabled={busy !== null}>
                {busy === "backup" ? "Preparing…" : "Download Backup"}
              </Button>
              <label
                htmlFor="settings-restore-file"
                className={cn(
                  "inline-flex h-8 cursor-pointer items-center rounded-md border border-input bg-background px-3 text-xs font-medium",
                  busy !== null && "pointer-events-none opacity-50",
                )}
              >
                {busy === "restore" ? "Restoring…" : "Restore from File…"}
              </label>
              <input
                id="settings-restore-file"
                type="file"
                accept=".tar.gz,application/gzip"
                className="sr-only"
                disabled={busy !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) {
                    void uploadRestore(file);
                  }
                }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Backups contain the database, evidence, artifacts, and candidate profile — never
              secrets. Restore always writes a rollback backup first.
            </p>
          </Section>
          <Section title="Storage">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">Database</dt>
                <dd className="font-mono tabular-nums font-medium">
                  {storage === null ? "…" : formatBytes(storage.databaseBytes + storage.walBytes)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Jobs</dt>
                <dd className="font-mono tabular-nums font-medium">{storage === null ? "…" : storage.jobCount}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Evidence</dt>
                <dd className="font-mono tabular-nums font-medium">
                  {storage === null
                    ? "…"
                    : `${formatBytes(storage.evidenceBytes)} · ${storage.evidenceFiles} files`}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Artifacts</dt>
                <dd className="font-mono tabular-nums font-medium">
                  {storage === null
                    ? "…"
                    : `${formatBytes(storage.artifactBytes)} · ${storage.artifactFiles} files`}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Backups</dt>
                <dd className="font-mono tabular-nums font-medium">
                  {storage === null
                    ? "…"
                    : `${storage.backupCount} · ${formatBytes(storage.backupsBytes)}`}
                </dd>
              </div>
            </dl>
          </Section>
              <div className="border-t border-border/40 pt-6">
          <Section title="Board Reset">
            {!resetArmed ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setResetArmed(true)}
                disabled={busy !== null}
              >
                Clear All Jobs…
              </Button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs">
                  This removes every job, extraction, and resume version. The candidate profile
                  is kept, and a safety backup is written first. Type{" "}
                  <kbd className="rounded border border-border bg-muted px-1 font-mono tabular-nums">
                    RESET
                  </kbd>{" "}
                  to confirm.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="settings-reset-confirm" className="sr-only">
                    Type RESET to confirm board reset
                  </label>
                  <input
                    id="settings-reset-confirm"
                    type="text"
                    autoComplete="off"
                    value={resetConfirm}
                    onChange={(event) => setResetConfirm(event.target.value)}
                    placeholder="RESET"
                    className="h-8 w-32 rounded-md border border-input bg-background px-3 text-sm"
                  />
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy !== null || resetConfirm !== "RESET"}
                    onClick={() => void submitReset()}
                  >
                    {busy === "reset" ? "Clearing…" : "Confirm Reset"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      setResetArmed(false);
                      setResetConfirm("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </Section>
              </div>
            </TabsContent>
            <TabsContent value="ai" className="workspace-tab mt-0 min-h-[400px]">
          <Section title="AI Providers">
            <div role="radiogroup" aria-label="Selected AI provider draft" className="grid gap-2 sm:grid-cols-3">
              {AI_PROVIDERS.map((item) => {
                const status = snapshot?.providers?.[item.id];
                const selected = selectedProvider === item.id;
                const running = snapshot?.activeProvider === item.id;
                const savedSelected =
                  (snapshot?.savedProvider ?? snapshot?.saved?.provider) === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => selectProvider(item.id)}
                    className={cn(
                      "rounded-lg border p-3 text-left transition-colors",
                      selected
                        ? "border-primary bg-primary/5 shadow-xs"
                        : "border-border hover:bg-muted/50",
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
                      {item.name}
                      {running && (
                        <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-semibold text-primary">
                          Active
                        </span>
                      )}
                      {savedSelected && (
                        <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
                          Saved
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block text-[11px]">
                      {status === undefined ? (
                        <span className="text-muted-foreground">…</span>
                      ) : status.configured ? (
                        <span className="font-medium text-emerald-600 dark:text-emerald-400">
                          Configured · {status.fingerprint}
                        </span>
                      ) : (
                        <span className="font-medium text-amber-600 dark:text-amber-400">
                          Key missing
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block font-mono tabular-nums text-[10px] text-muted-foreground">
                      {item.keyName}
                    </span>
                  </button>
                );
              })}
            </div>
            {snapshot?.restartNeeded === true && (
              <div
                role="note"
                aria-label="Restart required"
                className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
              >
                <p className="font-medium">
                  {savedName} saved — restart required.
                </p>
                <p className="mt-1">
                  The web process is still running {runningName}.
                  Stop and restart the app (<span className="font-mono tabular-nums">npm run dev</span> or{" "}
                  <span className="font-mono tabular-nums">npm run start</span>) to activate the saved
                  configuration in both web and worker. If it still differs after a restart, a
                  shell-exported variable is overriding the file — unset it and restart again.
                </p>
                {snapshot.restartDetail !== null && snapshot.restartDetail !== undefined && (
                  <p className="mt-1 text-[11px]">Pending: {snapshot.restartDetail}</p>
                )}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              {snapshot === null || snapshot === undefined ? (
                "Loading worker status…"
              ) : workerStatus === null ? (
                "Worker: not reported yet — start or restart the worker to verify it."
              ) : (
                <>
                  Worker: {workerName}{" "}
                  <span className="font-mono tabular-nums">
                    {workerStatus.models.primary} / {workerStatus.models.fallback}
                  </span>{" "}
                  · {workerStatus.keyConfigured ? "key set" : "no key"}
                  {snapshot.workerMatch === true ? " · matches web" : snapshot.workerMatch === false ? " · differs from web" : ""}
                  {!workerStatus.tailorConfigured && " · tailoring provider command missing"}
                </>
              )}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Saved primary</dt>
              <dd className="break-all font-mono tabular-nums text-[11px]">{snapshot?.saved?.providers?.[selectedProvider]?.models.primary ?? snapshot?.providers?.[selectedProvider]?.models.primary ?? "…"}</dd>
              <dt className="text-muted-foreground">Saved fallback</dt>
              <dd className="break-all font-mono tabular-nums text-[11px]">{snapshot?.saved?.providers?.[selectedProvider]?.models.fallback ?? snapshot?.providers?.[selectedProvider]?.models.fallback ?? "…"}</dd>
              <dt className="text-muted-foreground">Web-active primary</dt>
              <dd className="break-all font-mono tabular-nums text-[11px]">{snapshot?.providers?.[selectedProvider]?.models.primary ?? "…"}</dd>
              <dt className="text-muted-foreground">Web-active fallback</dt>
              <dd className="break-all font-mono tabular-nums text-[11px]">{snapshot?.providers?.[selectedProvider]?.models.fallback ?? "…"}</dd>
            </dl>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <label htmlFor="settings-model-primary" className="text-[11px] font-medium">
                  Primary model
                </label>
                <input
                  id="settings-model-primary"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={AI_PROVIDERS.find((item) => item.id === selectedProvider)?.primaryPlaceholder}
                  value={primary}
                  onChange={(event) => editPrimary(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 font-mono tabular-nums text-[11px] placeholder:text-muted-foreground/60"
                />
              </div>
              <div>
                <label htmlFor="settings-model-fallback" className="text-[11px] font-medium">
                  Fallback model
                </label>
                <input
                  id="settings-model-fallback"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={AI_PROVIDERS.find((item) => item.id === selectedProvider)?.fallbackPlaceholder}
                  value={fallback}
                  onChange={(event) => editFallback(event.target.value)}
                  className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 font-mono tabular-nums text-[11px] placeholder:text-muted-foreground/60"
                />
              </div>
            </div>
            <div>
              <label htmlFor="settings-api-key" className="text-[11px] font-medium">
                API key for {selectedName} (write-only)
              </label>
              <input
                id="settings-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  snapshot?.saved?.providers?.[selectedProvider]?.configured ?? snapshot?.providers?.[selectedProvider]?.configured
                    ? "Stored key present — blank retains it"
                    : "No stored key — enter one to save or test"
                }
                value={apiKey}
                onChange={(event) => editApiKey(event.target.value)}
                className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 font-mono tabular-nums text-[11px] placeholder:text-muted-foreground/60"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Blank retains the stored key. An entered key can be tested without saving, or saved
                explicitly — it is never displayed back.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void switchModelChain()} disabled={busy !== null}>
                {busy === "models" ? "Saving…" : "Save Models"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void saveApiKey()} disabled={busy !== null}>
                {busy === "key-save" ? "Saving…" : "Save Key"}
              </Button>
              <Button
                size="sm"
                variant={removeArmed ? "destructive" : "outline"}
                onClick={() => void removeApiKey()}
                disabled={busy !== null}
              >
                {busy === "key-remove" ? "Removing…" : removeArmed ? "Confirm Remove" : "Remove Key"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void testAi()} disabled={busy !== null}>
                {busy === "ai-test" ? "Testing…" : "Test Connection"}
              </Button>
            </div>
            {aiResult !== null && (
              <div
                className="space-y-1 rounded-md border border-border p-3 text-[11px]"
                role="group"
                aria-label="Connection test result"
              >
                <p className="font-medium">
                  {aiResult.ok ? "✓ Test passed" : "✗ Test failed"}
                  {aiResult.testedModel !== undefined && (
                    <>
                      {" "}· <span className="font-mono tabular-nums">{aiResult.testedModel}</span>
                    </>
                  )}
                  {aiResult.keySource !== undefined && (
                    <span className="text-muted-foreground">
                      {" "}({aiResult.keySource === "transient" ? "entered" : "stored"} key, nothing saved)
                    </span>
                  )}
                </p>
                {aiResult.ok ? (
                  <p className="text-muted-foreground">
                    Primary {aiResult.model} in {aiResult.latencyMs} ms
                    {aiResult.fallback !== null && aiResult.fallback !== undefined && (
                      <>
                        {aiResult.fallback.ok ? "; fallback " : "; FALLBACK FAILED "}
                        <span className="font-mono tabular-nums">{aiResult.fallback.model}</span>
                        {" "}in {aiResult.fallback.latencyMs} ms
                        {aiResult.fallback.ok
                          ? ""
                          : `: ${aiResult.fallback.error ?? "unknown"}${aiResult.fallback.action !== null && aiResult.fallback.action !== undefined ? ` ${aiResult.fallback.action}` : ""}`}
                      </>
                    )}
                  </p>
                ) : (
                  <>
                    <p>{aiResult.error ?? "unknown error"}</p>
                    {aiResult.action !== null && aiResult.action !== undefined && (
                      <p className="text-muted-foreground">{aiResult.action}</p>
                    )}
                    {aiResult.fallback !== null && aiResult.fallback !== undefined && !aiResult.fallback.ok && (
                      <p>
                        Fallback <span className="font-mono tabular-nums">{aiResult.fallback.model}</span>:{" "}
                        {aiResult.fallback.error ?? "unknown"}
                      </p>
                    )}
                  </>
                )}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Saving edits <span className="font-mono tabular-nums">.env.local</span>; restart the app to apply.
              API key values are never shown. A passing web test does not verify the worker launch
              path — the worker starts its own provider command.
            </p>
          </Section>
            </TabsContent>
            <TabsContent value="profile" className="workspace-tab mt-0 min-h-[400px] space-y-6">
          <Section title="Career Profiles">
            {profilesError !== null && (
              <p role="alert" className="text-xs text-destructive">
                Could not load profiles: {profilesError}{" "}
                <Button size="sm" variant="link" onClick={() => void refreshProfiles()} disabled={busy !== null}>
                  Retry
                </Button>
              </p>
            )}
            {profiles === null && profilesError === null && (
              <p className="text-xs text-muted-foreground">Loading profiles…</p>
            )}
            {profiles !== null && profiles.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No career profiles yet. Create one to scope resume versions and tailoring.
              </p>
            )}
            {profiles !== null && profiles.length > 0 && (
              <ul className="space-y-2">
                {profiles.map((profile) => {
                  const readiness = profileReadiness(profile);
                  return (
                    <li
                      key={profile.id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border px-3 py-2"
                    >
                      <div className="min-w-0 flex-1 basis-40">
                        <p className="truncate text-xs font-medium">
                          {profile.displayName}{" "}
                          {profile.isDefault && (
                            <span className="ml-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                              Default
                            </span>
                          )}
                        </p>
                        <p className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {profile.name} · {profile.versionCount}{" "}
                          {profile.versionCount === 1 ? "version" : "versions"} ·{" "}
                          {profile.approvedFacts} facts
                          {profile.activeVersion !== null &&
                            ` · active v${profile.activeVersion}`}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {readiness.state === "ready"
                            ? "Ready"
                            : readiness.state === "staged"
                              ? "Staged — needs activation"
                              : "Setup needed"}
                          {" · "}
                          {readiness.detail}
                        </p>
                      </div>
                      {!profile.isDefault && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => void setDefaultProfile(profile.id, profile.displayName)}
                        >
                          {busy === "profile-default" ? "Switching…" : "Set Default"}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant={workspaceId === profile.id ? "default" : "ghost"}
                        disabled={busy !== null}
                        onClick={() =>
                          requestWorkspace(workspaceId === profile.id ? null : profile.id)
                        }
                      >
                        {workspaceId === profile.id ? "Close setup" : "Set up"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {pendingWorkspaceId !== null && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
              >
                <span className="flex-1">
                  The open setup has unsaved changes. Discard them and switch?
                </span>
                <Button size="sm" variant="outline" onClick={() => setPendingWorkspaceId(null)}>
                  Keep editing
                </Button>
                <Button size="sm" variant="destructive" onClick={confirmWorkspaceSwitch}>
                  Discard changes
                </Button>
              </div>
            )}
            {creationMode === null ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || profiles === null}
                  onClick={() => setCreationMode("empty")}
                >
                  Start empty
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || profiles === null || profiles.length === 0}
                  onClick={() => setCreationMode("copy")}
                >
                  Create from existing profile
                </Button>
              </div>
            ) : creationMode === "empty" ? (
              <form
                aria-label="Start empty profile"
                className="space-y-2 rounded-md border border-border p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createEmptyProfile();
                }}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="grid gap-1">
                    <label htmlFor="empty-profile-name" className="text-xs font-medium">
                      Name (slug)
                    </label>
                    <input
                      id="empty-profile-name"
                      className="h-8 rounded-md border border-input bg-background px-2 font-mono text-xs tabular-nums"
                      value={emptyName}
                      placeholder="senior-pm"
                      required
                      disabled={busy !== null}
                      onChange={(event) => setEmptyName(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-1">
                    <label htmlFor="empty-profile-display" className="text-xs font-medium">
                      Display name
                    </label>
                    <input
                      id="empty-profile-display"
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                      value={emptyDisplayName}
                      placeholder="Senior Product Manager"
                      required
                      disabled={busy !== null}
                      onChange={(event) => setEmptyDisplayName(event.target.value)}
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" type="submit" disabled={busy !== null}>
                    {busy === "profile-create" ? "Creating…" : "Create empty profile"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => setCreationMode(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="space-y-2">
                <CopyProfileForm
                  profiles={profiles ?? []}
                  busy={busy}
                  onRun={run}
                  onCreated={(profileId) => {
                    setCreationMode(null);
                    void profilesChanged().then(() => {
                      setWorkspaceId(profileId);
                      setWorkspaceDirty(false);
                    });
                  }}
                />
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => setCreationMode(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {workspaceProfile !== null && (
              <div className="border-t border-border/40 pt-4">
                <ProfileWorkspace
                  key={`${workspaceProfile.id}-${workspaceResetKey}`}
                  profile={workspaceProfile}
                  busy={busy}
                  versionsTick={versionsTick}
                  onRun={run}
                  onProfilesChanged={profilesChanged}
                  onDirtyChange={setWorkspaceDirty}
                />
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Profiles are steering metadata only — they never add resume claims or bypass fact
              citations. Each profile is managed independently; setup never changes the default.
            </p>
          </Section>
          <Section title="Legacy Master File">
            {snapshot?.profile === null || snapshot?.profile === undefined ? (
              <p className="text-xs text-muted-foreground">
                No active profile. Set up a profile above, or add{" "}
                <span className="font-mono tabular-nums">data/candidate/master-resume.json</span>{" "}
                then re-sync.
              </p>
            ) : (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Candidate</dt>
                <dd className="font-medium">{snapshot.profile.displayName ?? "—"}</dd>
                <dt className="text-muted-foreground">Active version</dt>
                <dd className="font-mono tabular-nums font-medium">v{snapshot.profile.activeVersion}</dd>
                <dt className="text-muted-foreground">Last synced</dt>
                <dd className="font-mono tabular-nums font-medium">
                  {new Date(snapshot.profile.activeVersionAt).toLocaleString()}
                </dd>
                <dt className="text-muted-foreground">Verified skills</dt>
                <dd className="font-mono tabular-nums font-medium">{snapshot.profile.verifiedSkills}</dd>
              </dl>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => void resyncProfile()} disabled={busy !== null}>
                {busy === "resync" ? "Re-syncing…" : "Re-sync Master Resume"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Re-sync imports the legacy file into a new immutable version. Day-to-day
              onboarding — upload, paste, structured entry, review, activation, exports —
              happens per profile above; each profile keeps its own master history.
            </p>
          </Section>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
