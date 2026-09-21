"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { apiGet, apiPost } from "../api";
import { FORM_INPUT, FORM_LABEL } from "./PreferencesForm";
import type { ProfileVersionEntry, SettingsProfileSummary } from "./profiles";

/**
 * Create-from-existing form (C6/B6): copies one immutable source
 * version — always displayed and selectable, active by default —
 * into an independent inactive draft. Verification and lineage come
 * from the server; approvals and application history never copy.
 * The new profile still needs explicit activation.
 */
export default function CopyProfileForm({
  profiles,
  busy,
  onRun,
  onCreated,
}: {
  profiles: SettingsProfileSummary[];
  busy: string | null;
  onRun: (action: string, fn: () => Promise<string>) => Promise<void>;
  onCreated: (profileId: string) => void;
}) {
  const defaultProfile = profiles.find((entry) => entry.isDefault) ?? profiles[0] ?? null;
  const [sourceProfileId, setSourceProfileId] = useState(defaultProfile?.id ?? "");
  const [versions, setVersions] = useState<ProfileVersionEntry[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [sourceVersionId, setSourceVersionId] = useState("");
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const disabled = busy !== null;

  useEffect(() => {
    if (sourceProfileId === "") {
      // No source to load (empty profile list); versions stay null.
      return;
    }
    let cancelled = false;
    apiGet<{ versions: ProfileVersionEntry[] }>(
      `/api/settings/profiles/${sourceProfileId}/versions`,
    ).then(
      (data) => {
        if (cancelled) {
          return;
        }
        const list = Array.isArray(data.versions) ? data.versions : [];
        setVersions(list);
        const active = list.find((entry) => entry.active) ?? list[0] ?? null;
        setSourceVersionId(active?.id ?? "");
      },
      (error: unknown) => {
        if (!cancelled) {
          setVersionsError(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sourceProfileId]);

  const sourceProfile = profiles.find((entry) => entry.id === sourceProfileId) ?? null;
  const sourceVersion = versions?.find((entry) => entry.id === sourceVersionId) ?? null;

  async function submit(): Promise<void> {
    const trimmedName = name.trim();
    const trimmedDisplay = displayName.trim();
    await onRun("profile-copy", async () => {
      const body = await apiPost<{
        ok: boolean;
        profileId: string;
        versionId: string;
        version: number;
        copiedFacts: number;
      }>("/api/settings/profiles/copy", {
        sourceProfileId,
        ...(sourceVersionId === "" ? {} : { sourceVersionId }),
        name: trimmedName,
        displayName: trimmedDisplay,
      });
      onCreated(body.profileId);
      return `“${trimmedDisplay}” created from “${sourceProfile?.displayName ?? "?"}” v${sourceVersion?.version ?? "?"} as an inactive draft (${body.copiedFacts} facts with provenance) — review and activate it below.`;
    });
  }

  return (
    <form
      aria-label="Create profile from existing"
      className="space-y-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-1 sm:grid-cols-2 sm:gap-2">
        <div className="grid gap-1">
          <label htmlFor="copy-source-profile" className={FORM_LABEL}>
            Source profile
          </label>
          <select
            id="copy-source-profile"
            className={FORM_INPUT}
            value={sourceProfileId}
            disabled={disabled}
            onChange={(event) => {
              setSourceProfileId(event.target.value);
              setVersions(null);
              setVersionsError(null);
            }}
          >
            {profiles.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.displayName}
                {entry.isDefault ? " (default)" : ""}
                {entry.versionCount === 0 ? " — no versions" : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1">
          <label htmlFor="copy-source-version" className={FORM_LABEL}>
            Source version
          </label>
          {versions === null && versionsError === null ? (
            <p className="text-xs text-muted-foreground">Loading versions…</p>
          ) : versionsError !== null ? (
            <p role="alert" className="text-xs text-destructive">
              Could not load versions: {versionsError}
            </p>
          ) : (versions ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              The source profile has no versions — onboard a master there first.
            </p>
          ) : (
            <select
              id="copy-source-version"
              className={FORM_INPUT}
              value={sourceVersionId}
              disabled={disabled}
              onChange={(event) => setSourceVersionId(event.target.value)}
            >
              {(versions ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  v{entry.version}
                  {entry.active ? " (active)" : " (draft)"} · {entry.facts.total} facts ·{" "}
                  {entry.source === null ? "no recorded source" : entry.source.origin}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {sourceVersion !== null && (
        <p className="text-[11px] text-muted-foreground">
          Copying v{sourceVersion.version} ({sourceVersion.active ? "active" : "draft"}) of “
          {sourceProfile?.displayName}”: facts keep their verification with recorded provenance.
          No approvals or application history copy over.
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="grid gap-1">
          <label htmlFor="copy-name" className={FORM_LABEL}>
            Name (slug)
          </label>
          <input
            id="copy-name"
            className={`${FORM_INPUT} font-mono tabular-nums`}
            value={name}
            placeholder="senior-pm"
            required
            disabled={disabled}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <label htmlFor="copy-display" className={FORM_LABEL}>
            Display name
          </label>
          <input
            id="copy-display"
            className={FORM_INPUT}
            value={displayName}
            placeholder="Senior Product Manager"
            required
            disabled={disabled}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
      </div>
      <div>
        <Button
          size="sm"
          type="submit"
          disabled={disabled || sourceVersionId === "" || name.trim() === "" || displayName.trim() === ""}
        >
          {busy === "profile-copy" ? "Copying…" : "Create from existing"}
        </Button>
      </div>
    </form>
  );
}
