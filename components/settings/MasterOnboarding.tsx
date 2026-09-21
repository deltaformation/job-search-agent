"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ApiError, apiPost, errorMessage } from "../api";
import MasterDocumentForm from "./MasterDocumentForm";
import MasterPreview, { type PreviewPayload } from "./MasterPreview";
import { issuePathLabel, type MasterResumeIssue, type SettingsProfileSummary } from "./profiles";

interface StagedDocument {
  document: Record<string, unknown>;
  payload: PreviewPayload;
  summary: {
    employments: number;
    achievements: number;
    approvedAchievements: number;
    pendingAchievements: number;
    skills: number;
    verifiedSkills: number;
    languages: number;
    education: number;
    credentials: number;
  };
}

/**
 * Master onboarding for one profile (C2/C3): JSON upload, paste, or
 * structured entry → no-write validation with field-level issues →
 * full parsed preview → explicit "Review and activate". Entered
 * content is never cleared by a validation failure; activation is a
 * separate human action from preference saving.
 */
export default function MasterOnboarding({
  profile,
  busy,
  onRun,
  onChanged,
  onDirtyChange,
}: {
  profile: SettingsProfileSummary;
  busy: string | null;
  onRun: (action: string, fn: () => Promise<string>) => Promise<void>;
  onChanged: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [mode, setMode] = useState<"structured" | "json">("structured");
  const [jsonText, setJsonText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [issues, setIssues] = useState<MasterResumeIssue[]>([]);
  const [staged, setStaged] = useState<StagedDocument | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const prefix = `onboard-${profile.id}`;
  const disabled = busy !== null;

  function reportDirty(nextFormDirty: boolean, nextJsonText: string): void {
    setFormDirty(nextFormDirty);
    onDirtyChange?.(nextFormDirty || nextJsonText.trim() !== "" || staged !== null);
  }

  async function validateDocument(document: Record<string, unknown>): Promise<void> {
    setJsonError(null);
    await onRun("master-validate", async () => {
      // The parse route reports field-level issues as HTTP 422 with an
      // `{ok:false, issues}` body (route contract), which apiPost raises
      // as ApiError — recover the issues from the payload instead of
      // surfacing a generic failure and losing the field highlights.
      let body:
        | { ok: true; payload: PreviewPayload; summary: StagedDocument["summary"] }
        | { ok: false; issues: MasterResumeIssue[] };
      try {
        body = await apiPost<
          | { ok: true; payload: PreviewPayload; summary: StagedDocument["summary"] }
          | { ok: false; issues: MasterResumeIssue[] }
        >("/api/settings/master-resume/parse", { content: document });
      } catch (error: unknown) {
        if (error instanceof ApiError && error.status === 422) {
          const payload = error.payload as { ok?: unknown; issues?: unknown } | null;
          if (payload !== null && payload.ok === false && Array.isArray(payload.issues)) {
            body = { ok: false, issues: payload.issues as MasterResumeIssue[] };
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }
      if (!body.ok) {
        setIssues(body.issues);
        setStaged(null);
        onDirtyChange?.(true);
        return `${body.issues.length} validation ${body.issues.length === 1 ? "issue" : "issues"} — fix the highlighted fields and validate again. Nothing was saved.`;
      }
      setIssues([]);
      setStaged({ document, payload: body.payload, summary: body.summary });
      onDirtyChange?.(true);
      return "Document is valid — review the full preview below, then activate explicitly.";
    });
  }

  function validateJsonText(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText) as unknown;
    } catch {
      setJsonError("That is not valid JSON — the text is preserved; fix it and validate again.");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setJsonError("A master document must be a JSON object — the text is preserved.");
      return;
    }
    void validateDocument(parsed as Record<string, unknown>);
  }

  async function readUpload(file: File): Promise<void> {
    if (file.size > 2_000_000) {
      setJsonError(`“${file.name}” is larger than the 2 MB upload limit.`);
      return;
    }
    try {
      const text = await file.text();
      setJsonText(text);
      setFileName(file.name);
      setJsonError(null);
      setMode("json");
      reportDirty(formDirty, text);
    } catch (error: unknown) {
      setJsonError(`Could not read “${file.name}”: ${errorMessage(error)}`);
    }
  }

  async function loadExample(): Promise<void> {
    setJsonError(null);
    await onRun("master-example", async () => {
      const response = await fetch("/examples/master-resume.json");
      if (!response.ok) {
        throw new Error(`example failed to load (${response.status})`);
      }
      const text = await response.text();
      setJsonText(text);
      setFileName("master-resume.json (example)");
      setMode("json");
      reportDirty(formDirty, text);
      return "Example loaded into the JSON editor — validate it to preview, or edit first.";
    });
  }

  async function activateStaged(): Promise<void> {
    if (staged === null) {
      return;
    }
    const document = staged.document;
    await onRun("master-activate", async () => {
      const body = await apiPost<{
        ok: boolean;
        versionId: string;
        version: number;
        activated: boolean;
        alreadyCurrent: boolean;
      }>("/api/settings/master-resume", { content: document, profileId: profile.id, activate: true });
      setStaged(null);
      setIssues([]);
      onDirtyChange?.(jsonText.trim() !== "");
      await onChanged();
      return body.alreadyCurrent
        ? `This document already matches active version ${body.version}; nothing changed.`
        : `“${profile.displayName}” master reviewed and activated as version ${body.version}.`;
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Master entry mode" className="flex gap-1">
          <Button
            size="sm"
            type="button"
            variant={mode === "structured" ? "default" : "outline"}
            disabled={disabled}
            onClick={() => setMode("structured")}
          >
            Structured form
          </Button>
          <Button
            size="sm"
            type="button"
            variant={mode === "json" ? "default" : "outline"}
            disabled={disabled}
            onClick={() => setMode("json")}
          >
            JSON upload / paste
          </Button>
        </div>
        <a
          href="/examples/master-resume.json"
          download="master-resume-example.json"
          className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-xs font-medium"
        >
          Download example
        </a>
        <Button size="sm" type="button" variant="ghost" disabled={disabled} onClick={() => void loadExample()}>
          {busy === "master-example" ? "Loading…" : "Load example"}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Documents use schema <span className="font-mono tabular-nums">candidate-import/v2</span>:
        identity with contact links, employment, achievements with minted fact ids, skills,
        languages, education, and credentials. Validation never writes; activation below is the
        explicit review action.
      </p>

      {mode === "structured" ? (
        <MasterDocumentForm
          idPrefix={`${prefix}-form`}
          disabled={disabled}
          issues={issues}
          submitLabel={busy === "master-validate" ? "Validating…" : "Validate & preview"}
          onSubmitDocument={(document) => void validateDocument(document)}
          onDirtyChange={(dirty) => reportDirty(dirty, jsonText)}
        />
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor={`${prefix}-file`}
              className={cn(
                "inline-flex h-8 cursor-pointer items-center rounded-md border border-input bg-background px-3 text-xs font-medium",
                disabled && "pointer-events-none opacity-50",
              )}
            >
              Choose JSON file…
            </label>
            <input
              id={`${prefix}-file`}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              disabled={disabled}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) {
                  void readUpload(file);
                }
              }}
            />
            {fileName !== null && (
              <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                {fileName}
              </span>
            )}
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${prefix}-json`} className="text-xs font-medium">
              Master JSON (paste or loaded file)
            </label>
            <textarea
              id={`${prefix}-json`}
              rows={10}
              spellCheck={false}
              className="rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[11px] tabular-nums"
              value={jsonText}
              disabled={disabled}
              onChange={(event) => {
                setJsonText(event.target.value);
                reportDirty(formDirty, event.target.value);
              }}
            />
          </div>
          <div>
            <Button size="sm" type="button" disabled={disabled} onClick={validateJsonText}>
              {busy === "master-validate" ? "Validating…" : "Validate & preview"}
            </Button>
          </div>
        </div>
      )}

      {jsonError !== null && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {jsonError}
        </p>
      )}

      {issues.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3" role="alert">
          <p className="text-xs font-semibold text-destructive">
            {issues.length} validation {issues.length === 1 ? "issue" : "issues"} — nothing was
            saved; your input is preserved.
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {issues.slice(0, 12).map((issue, index) => (
              <li key={`${issuePathLabel(issue.path)}-${index}`}>
                <span className="font-mono tabular-nums">{issuePathLabel(issue.path) === "" ? "(document)" : issuePathLabel(issue.path)}</span>
                : {issue.message}
              </li>
            ))}
          </ul>
          {issues.length > 12 && (
            <p className="text-[11px] text-muted-foreground">…and {issues.length - 12} more.</p>
          )}
        </div>
      )}

      {staged !== null && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs font-semibold">
            Parsed preview — {staged.summary.employments}{" "}
            {staged.summary.employments === 1 ? "role" : "roles"},{" "}
            {staged.summary.achievements} achievements ({staged.summary.pendingAchievements}{" "}
            pending), {staged.summary.skills} skills, {staged.summary.languages} languages,{" "}
            {staged.summary.education} education, {staged.summary.credentials} credentials.
          </p>
          <MasterPreview payload={staged.payload} />
          <div className="flex flex-wrap gap-2 border-t border-border/40 pt-2">
            <Button size="sm" type="button" disabled={disabled} onClick={() => void activateStaged()}>
              {busy === "master-activate" ? "Activating…" : "Review and activate master"}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => {
                setStaged(null);
                onDirtyChange?.(formDirty || jsonText.trim() !== "");
              }}
            >
              Discard preview
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
