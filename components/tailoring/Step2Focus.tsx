"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Edit2,
  ExternalLink,
  Eye,
  GripVertical,
  Info,
  Loader2,
  Quote,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import MasterPreview, { type PreviewPayload } from "@/components/settings/MasterPreview";
import { openSettings } from "@/components/settings/profiles";
import type { StoredProfilePayload } from "@/src/domain/candidate";
import {
  STEP2_SCHEMA_VERSIONS,
  masterBulletsByRole,
  type PreparationPlanV1 as PreparationPlanV1Type,
  type PreparationStatusV1 as PreparationStatusV1Type,
  type Step2DraftOperationV1 as Step2DraftOperationV1Type,
  type Step2DraftV1 as Step2DraftV1Type,
  type Step2ValidationV1 as Step2ValidationV1Type,
  type WorkspacePutV2 as WorkspacePutV2Type,
  type WorkspaceViewV2,
} from "@/src/domain/step2";
import {
  STEP2_CORRECTION_VERSIONS,
  type PreparationPlanV2 as PreparationPlanV2Type,
  type Step2DraftV2 as Step2DraftV2Type,
  type Step2SummaryOrigin as Step2SummaryOriginType,
  type Step2ValidationV2 as Step2ValidationV2Type,
  type WorkspacePutV3 as WorkspacePutV3Type,
  type WorkspaceViewV3,
} from "@/src/domain/step2Correction";
import {
  TAILORING_SUBMIT_SCHEMA_VERSION,
  buildWorkspaceETag,
  type WorkspaceView,
} from "@/src/domain/tailoringWorkspace";
import {
  AUTOSAVE_DEBOUNCE_MS,
  clearPendingGeneration,
  parseTailoringError,
  randomOperationId,
  readPendingGeneration,
  writePendingGeneration,
  type PendingGeneration,
} from "./focusDraft";
import type { StepNumber } from "./StepIndicator";
import {
  applyStep2Operations,
  budgetLines,
  draftSnapshot,
  employmentLabel,
  indexEditorSegments,
  matchSummaryOrigin,
  operationIndexFromField,
  sortRoleGroups,
  summarySourceFor,
  type AppliedBulletRow,
  type BulletRoleGroup,
  type EditorDraftOperation,
  type EditorSegmentState,
  type SummarySource,
} from "./step2DraftView";

export interface Step2FocusProps {
  jobId: string;
  activeExtractionId: string | null;
  initialJobRowVersion: number;
  initialWorkspace: WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3 | null;
  canGenerate: boolean;
  onNavigateStep: (step: StepNumber) => void;
}

/**
 * Step 2 prepared-plan editor (WO-1.3-S2-C): captured profile text
 * with preview plus Settings edit, plan priorities/positioning,
 * master bullets by employer with ordered Add/Replace/Exclude/edit
 * operations, exact-text validation badges, and advisory
 * length guidance. All durable state flows through the v2 workspace PUT
 * (500ms debounce, one in-flight save, 412 retention); cancel and
 * navigation never write. Mount performs GETs only — preparation
 * and retry run solely from explicit buttons.
 */

const PREP_POLL_VISIBLE_MS = 2000;
const PREP_POLL_HIDDEN_MS = 10000;
const SUMMARY_MAX_CHARS = 4000;

type LoadState = "loading" | "ready" | "error";
type PlanLoadState = "loading" | "ready" | "missing" | "error";
type SaveState = "clean" | "dirty" | "saving" | "conflict" | "plan-stale" | "error";

interface CapturedProfile {
  profile: { id: string; displayName: string };
  version: { id: string; version: number };
  payload: StoredProfilePayload;
}

interface AcceptedPlan {
  version: 1 | 2;
  plan: PreparationPlanV1Type | PreparationPlanV2Type;
  planHash: string;
  /**
   * Server-derived eligible roles per suggestion (v2 plans
   * only; v1 plans keep every payload employment eligible).
   */
  eligibleRoles: Map<string, string[]>;
}

/** Parse a version-tagged plan reply; null when unreadable. */
function parsePlanBody(body: {
  plan?: { schemaVersion?: unknown };
  planHash?: unknown;
  eligibleRoles?: unknown;
}): AcceptedPlan | null {
  const plan = body.plan as PreparationPlanV1Type | PreparationPlanV2Type | undefined;
  if (plan === undefined || typeof body.planHash !== "string") {
    return null;
  }
  if (plan.schemaVersion === STEP2_CORRECTION_VERSIONS.plan) {
    const eligible = new Map<string, string[]>();
    if (Array.isArray(body.eligibleRoles)) {
      for (const entry of body.eligibleRoles as Array<{ suggestionId?: unknown; eligibleRoleIds?: unknown }>) {
        if (typeof entry.suggestionId === "string" && Array.isArray(entry.eligibleRoleIds)) {
          eligible.set(
            entry.suggestionId,
            (entry.eligibleRoleIds as unknown[]).filter(
              (roleId): roleId is string => typeof roleId === "string",
            ),
          );
        }
      }
    }
    return { version: 2, plan: plan as PreparationPlanV2Type, planHash: body.planHash, eligibleRoles: eligible };
  }
  if (plan.schemaVersion === STEP2_SCHEMA_VERSIONS.plan) {
    return { version: 1, plan: plan as PreparationPlanV1Type, planHash: body.planHash, eligibleRoles: new Map() };
  }
  return null;
}

interface SavedHeader {
  requestKind: "INITIAL" | "NEW_VERSION" | "REVISION";
  parentVersionId: string | null;
  revisionNote: string | null;
}

interface ProfilesListItem {
  id: string;
  displayName: string;
  isDefault: boolean;
}

function headerFromWorkspace(
  workspace: WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3 | null,
): SavedHeader {
  const draft = workspace?.draft;
  if (draft === undefined || draft === null) {
    return { requestKind: "INITIAL", parentVersionId: null, revisionNote: null };
  }
  return {
    requestKind: draft.requestKind,
    parentVersionId: draft.parentVersionId,
    revisionNote: draft.revisionNote,
  };
}

function supportBadge(support: "supported" | "related" | "gap"): string {
  if (support === "supported") {
    return "Supported";
  }
  if (support === "related") {
    return "Related experience";
  }
  return "Gap";
}

function renderSupportBadge(support: "supported" | "related" | "gap"): ReactNode {
  const label = supportBadge(support);
  if (support === "supported") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1"
      >
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <span>{label}</span>
      </Badge>
    );
  }
  if (support === "related") {
    return (
      <Badge
        variant="outline"
        className="border-sky-500/30 bg-sky-500/10 font-medium text-sky-700 dark:text-sky-400 inline-flex items-center gap-1"
      >
        <ArrowRight className="h-3 w-3 text-sky-600 dark:text-sky-400" aria-hidden="true" />
        <span>{label}</span>
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-amber-500/30 bg-amber-500/10 font-medium text-amber-700 dark:text-amber-400 inline-flex items-center gap-1"
    >
      <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <span>{label}</span>
    </Badge>
  );
}

function preparationLabel(state: PreparationStatusV1Type["state"]): string {
  switch (state) {
    case "ABSENT":
      return "Not prepared";
    case "PENDING":
      return "Pending";
    case "QUEUED":
      return "Queued";
    case "RUNNING":
      return "Preparing";
    case "SUCCEEDED":
      return "Plan ready";
    case "FAILED":
      return "Failed";
  }
}

function stageLabel(stage: string): string {
  switch (stage) {
    case "LOADING_INPUTS":
      return "Loading inputs";
    case "WAITING_FOR_PROVIDER":
      return "Waiting for provider";
    case "VALIDATING_PROPOSAL":
      return "Validating proposal";
    case "STORING_PLAN":
      return "Storing plan";
    case "PUBLISHING_PLAN":
      return "Publishing plan";
    default:
      return stage;
  }
}

function failureHint(action: string | undefined): string | null {
  switch (action) {
    case "edit_profile":
      return "Resolve it in Settings, then retry.";
    case "open_settings":
      return "Open Settings to configure the provider, then retry.";
    case "retry":
      return "Retry when ready.";
    case "wait":
      return "Wait a moment, then retry.";
    case "edit_focus":
      return "Adjust the editor draft, then retry.";
    default:
      return null;
  }
}

function isV2View(view: WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3): view is WorkspaceViewV2 {
  return view.draft.schemaVersion === "tailoring-workspace/v2";
}

function isV3View(view: WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3): view is WorkspaceViewV3 {
  return view.draft.schemaVersion === "tailoring-workspace/v3";
}

function opSummary(
  op: EditorDraftOperation,
  employmentName: (roleId: string) => string,
): string {
  switch (op.op) {
    case "add":
      return `Add ${op.suggestionId} to ${employmentName(op.roleId)}${op.editedText !== null ? " (edited)" : ""}`;
    case "replace":
      return `Replace ${op.targetFactId} with ${op.suggestionId ?? "edited text"} in ${employmentName(op.roleId)}`;
    case "exclude":
      return `Exclude ${op.targetFactId}`;
    case "edit":
      return op.target.kind === "suggestion"
        ? `Edit added ${op.target.suggestionId}`
        : `Reword ${op.target.factId}`;
  }
}

export default function Step2Focus({
  jobId,
  activeExtractionId,
  initialJobRowVersion,
  initialWorkspace,
  canGenerate,
  onNavigateStep,
}: Step2FocusProps) {
  const [generateState, setGenerateState] = useState<"idle" | "working">("idle");
  const [generateError, setGenerateError] = useState<string | null>(null);
  // Resurface an uncertain submission after reload (E §4.3 replay
  // protocol): the exact bytes stay replayable, never forked.
  const [pendingGen, setPendingGen] = useState<PendingGeneration | null>(() =>
    readPendingGeneration(jobId),
  );
  const initialV2 =
    initialWorkspace !== null && isV2View(initialWorkspace) ? initialWorkspace : null;
  const initialV3 =
    initialWorkspace !== null && isV3View(initialWorkspace) ? initialWorkspace : null;
  const initialSavedDraft: Step2DraftV1Type | Step2DraftV2Type | null =
    initialV2?.draft.draft ?? initialV3?.draft.draft ?? null;

  const [prep, setPrep] = useState<PreparationStatusV1Type | null>(null);
  const [prepState, setPrepState] = useState<LoadState>("loading");
  const [prepError, setPrepError] = useState<string | null>(null);
  const [profileData, setProfileData] = useState<CapturedProfile | null>(null);
  const [profileState, setProfileState] = useState<LoadState>("loading");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [planData, setPlanData] = useState<AcceptedPlan | null>(null);
  const [planState, setPlanState] = useState<PlanLoadState>("loading");
  const [planError, setPlanError] = useState<string | null>(null);

  const [revision, setRevision] = useState<number>(initialWorkspace?.revision ?? 0);
  const [savedDraft, setSavedDraft] = useState<Step2DraftV1Type | Step2DraftV2Type | null>(
    initialSavedDraft,
  );
  const [savedPlanBinding, setSavedPlanBinding] = useState<{ planId: string; planHash: string } | null>(
    initialV2?.draft.planId === null || initialV2?.draft.planId === undefined
      ? null
      : { planId: initialV2.draft.planId, planHash: initialV2.draft.planHash as string },
  );
  const [savedHeader, setSavedHeader] = useState<SavedHeader>(() =>
    headerFromWorkspace(initialWorkspace),
  );
  const [hasV1Stored, setHasV1Stored] = useState<boolean>(
    initialWorkspace !== null &&
      initialWorkspace.draft.schemaVersion === "tailoring-workspace/v1",
  );

  const [summaryText, setSummaryText] = useState<string>(initialSavedDraft?.summaryText ?? "");
  const [operations, setOperations] = useState<EditorDraftOperation[]>(
    initialSavedDraft?.operations ?? [],
  );
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  /**
   * Explicit v2 summary origin (v2 drafts name it; edits preserve
   * it). v1 drafts keep deriving `summarySource` from text.
   */
  const [summaryOrigin, setSummaryOrigin] = useState<Step2SummaryOriginType>(
    initialV3?.draft.draft?.summaryOrigin ?? "master",
  );

  const [saveState, setSaveState] = useState<SaveState>("clean");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [opErrorIndex, setOpErrorIndex] = useState<number | null>(null);

  const [verdicts, setVerdicts] = useState<Step2ValidationV1Type | Step2ValidationV2Type | null>(null);
  const [checkedSnapshot, setCheckedSnapshot] = useState<string | null>(null);
  const [checkingCount, setCheckingCount] = useState<number>(0);
  const [validateError, setValidateError] = useState<string | null>(null);
  const checking = checkingCount > 0;

  const [profilesList, setProfilesList] = useState<ProfilesListItem[] | null>(null);
  const [preparing, setPreparing] = useState<boolean>(false);
  const [prepActionError, setPrepActionError] = useState<string | null>(null);
  const [jobRowVersion, setJobRowVersion] = useState<number>(initialJobRowVersion);

  const [previewOpen, setPreviewOpen] = useState<boolean>(false);
  const [themeConfirm, setThemeConfirm] = useState<SummarySource | null>(null);
  const [replaceFor, setReplaceFor] = useState<string | null>(null);
  const [editBuffer, setEditBuffer] = useState<{ key: string; text: string } | null>(null);
  const [dragOverRole, setDragOverRole] = useState<string | null>(null);
  const [dndError, setDndError] = useState<string | null>(null);

  const revisionRef = useRef<number>(initialWorkspace?.revision ?? 0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const errorSnapshotRef = useRef<string | null>(null);
  const buffersRef = useRef<{ summaryText: string; operations: EditorDraftOperation[] }>({
    summaryText: initialSavedDraft?.summaryText ?? "",
    operations: initialSavedDraft?.operations ?? [],
  });
  const prefilledRef = useRef(false);

  useEffect(() => {
    buffersRef.current = { summaryText, operations };
  });

  const setRevisionBoth = useCallback((value: number) => {
    revisionRef.current = value;
    setRevision(value);
  }, []);

  const adoptWorkspaceView = useCallback(
    (view: WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3 | null) => {
      if (view === null) {
        setRevisionBoth(0);
        setSavedDraft(null);
        setSavedPlanBinding(null);
        setHasV1Stored(false);
        return;
      }
      setRevisionBoth(view.revision);
      setSavedHeader(headerFromWorkspace(view));
      if (view.draft.schemaVersion === "tailoring-workspace/v2") {
        setHasV1Stored(false);
        setSavedPlanBinding(
          view.draft.planId === null
            ? null
            : { planId: view.draft.planId, planHash: view.draft.planHash as string },
        );
        setSavedDraft(view.draft.draft);
        setSummaryText(view.draft.draft?.summaryText ?? "");
        setOperations(view.draft.draft?.operations ?? []);
      } else if (view.draft.schemaVersion === "tailoring-workspace/v3") {
        setHasV1Stored(false);
        setSavedPlanBinding(
          view.draft.planId === null
            ? null
            : { planId: view.draft.planId, planHash: view.draft.planHash as string },
        );
        setSavedDraft(view.draft.draft);
        setSummaryText(view.draft.draft?.summaryText ?? "");
        setOperations(view.draft.draft?.operations ?? []);
        setSummaryOrigin(view.draft.draft?.summaryOrigin ?? "master");
      } else {
        setHasV1Stored(true);
      }
    },
    [setRevisionBoth],
  );

  /* ---------------- loading (GETs only; no AI on navigation) ---------------- */

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      setPrepState("loading");
      setPlanState("loading");
      setProfileState("loading");
      setPrepError(null);
      setPlanError(null);
      setProfileError(null);
      let loadedPrep: PreparationStatusV1Type | null = null;
      try {
        const prepResponse = await fetch(`/api/jobs/${jobId}/tailoring/preparation`);
        if (cancelled) {
          return;
        }
        if (!prepResponse.ok) {
          const parsed = await parseTailoringError(prepResponse);
          setPrepError(parsed.message);
          setPrepState("error");
        } else {
          const body = (await prepResponse.json()) as { preparation?: unknown };
          loadedPrep = body.preparation as PreparationStatusV1Type;
          setPrep(loadedPrep);
          setPrepState("ready");
        }
      } catch (error) {
        if (!cancelled) {
          setPrepError(error instanceof Error ? error.message : String(error));
          setPrepState("error");
        }
      }
      try {
        const workspaceResponse = await fetch(`/api/jobs/${jobId}/tailoring/workspace`);
        if (!cancelled && workspaceResponse.ok) {
          const body = (await workspaceResponse.json()) as {
            workspace?: WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3 | null;
          };
          adoptWorkspaceView(body.workspace ?? null);
        }
      } catch {
        // Keep SSR-seeded state; the next save attempt surfaces the fault.
      }
      try {
        const planResponse = await fetch(`/api/jobs/${jobId}/tailoring/plan`);
        if (cancelled) {
          return;
        }
        if (planResponse.status === 404) {
          setPlanState("missing");
        } else if (!planResponse.ok) {
          const parsed = await parseTailoringError(planResponse);
          setPlanError(parsed.message);
          setPlanState("error");
        } else {
          const body = (await planResponse.json()) as {
            plan?: { schemaVersion?: unknown };
            planHash?: unknown;
            eligibleRoles?: unknown;
          };
          const parsed = parsePlanBody(body);
          if (parsed !== null) {
            setPlanData(parsed);
            setPlanState("ready");
          } else {
            setPlanError("The accepted plan reply is unreadable.");
            setPlanState("error");
          }
        }
      } catch (error) {
        if (!cancelled) {
          setPlanError(error instanceof Error ? error.message : String(error));
          setPlanState("error");
        }
      }
      const binding = loadedPrep?.binding ?? null;
      if (binding === null) {
        if (!cancelled) {
          setProfileState("ready");
        }
        return;
      }
      try {
        const versionResponse = await fetch(
          `/api/settings/profiles/${encodeURIComponent(binding.profileId)}/versions/${encodeURIComponent(binding.profileVersionId)}`,
        );
        if (cancelled) {
          return;
        }
        if (!versionResponse.ok) {
          setProfileError(`Captured profile version cannot be read (${versionResponse.status}).`);
          setProfileState("error");
          return;
        }
        const body = (await versionResponse.json()) as {
          profile?: { id: string; displayName: string };
          version?: { id: string; version: number };
          payload?: unknown;
        };
        const payload = body.payload as StoredProfilePayload | undefined;
        if (
          body.profile === undefined ||
          body.version === undefined ||
          payload === undefined ||
          !Array.isArray(payload.employment) ||
          !Array.isArray(payload.achievements)
        ) {
          setProfileError("The captured profile payload is unreadable.");
          setProfileState("error");
          return;
        }
        setProfileData({ profile: body.profile, version: body.version, payload });
        setProfileState("ready");
      } catch (error) {
        if (!cancelled) {
          setProfileError(error instanceof Error ? error.message : String(error));
          setProfileState("error");
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [jobId, adoptWorkspaceView]);

  const reloadPreparation = useCallback(async (): Promise<PreparationStatusV1Type | null> => {
    try {
      const response = await fetch(`/api/jobs/${jobId}/tailoring/preparation`);
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { preparation?: PreparationStatusV1Type };
      if (body.preparation === undefined) {
        return null;
      }
      setPrep(body.preparation);
      setPrepState("ready");
      return body.preparation;
    } catch {
      return null;
    }
  }, [jobId]);

  const reloadPlan = useCallback(async (): Promise<AcceptedPlan | null> => {
    try {
      const response = await fetch(`/api/jobs/${jobId}/tailoring/plan`);
      if (response.status === 404) {
        setPlanState("missing");
        setPlanData(null);
        return null;
      }
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as {
        plan?: { schemaVersion?: unknown };
        planHash?: unknown;
        eligibleRoles?: unknown;
      };
      const parsed = parsePlanBody(body);
      if (parsed === null) {
        return null;
      }
      setPlanData(parsed);
      setPlanState("ready");
      return parsed;
    } catch {
      return null;
    }
  }, [jobId]);

  /* Preparation polling while non-terminal (batch GET cadence: 2s/10s). */
  useEffect(() => {
    if (prep === null || prepState !== "ready") {
      return;
    }
    if (prep.state !== "PENDING" && prep.state !== "QUEUED" && prep.state !== "RUNNING") {
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async (): Promise<void> => {
      const next = await reloadPreparation();
      if (stopped) {
        return;
      }
      if (next !== null && next.state === "SUCCEEDED") {
        void reloadPlan();
        return;
      }
      timer = setTimeout(tick, document.hidden ? PREP_POLL_HIDDEN_MS : PREP_POLL_VISIBLE_MS);
    };
    timer = setTimeout(tick, document.hidden ? PREP_POLL_HIDDEN_MS : PREP_POLL_VISIBLE_MS);
    const onVisibility = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (!stopped) {
        timer = setTimeout(tick, document.hidden ? PREP_POLL_HIDDEN_MS : PREP_POLL_VISIBLE_MS);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [prep, prepState, reloadPreparation, reloadPlan]);

  /* ---------------- derived data ---------------- */

  const payload = profileData?.payload ?? null;
  const plan = planData?.plan ?? null;

  const master = useMemo(() => {
    if (payload === null) {
      return [];
    }
    try {
      return masterBulletsByRole(payload);
    } catch {
      return [];
    }
  }, [payload]);

  const roleGroups: BulletRoleGroup[] = useMemo(
    () => sortRoleGroups(applyStep2Operations(master, plan, operations), payload),
    [master, plan, operations, payload],
  );

  const budgets = useMemo(
    () => budgetLines(summaryText, master, operations, payload),
    [summaryText, master, operations, payload],
  );

  // Advisory length guidance (live, pre-submit): bullet counts
  // are a concision hint, never a generation blocker.
  const lengthGuidance = useMemo(() => {
    const totalLine = budgets.lines.find((line) => line.key === "total");
    const denseRoles = budgets.lines.filter(
      (line) => line.key.startsWith("role:") && line.exceeded,
    );
    return {
      show: (totalLine?.exceeded ?? false) || denseRoles.length > 0,
      totalBullets: budgets.totalBullets,
      denseRoles,
    };
  }, [budgets]);

  // v2 drafts fold the explicit summary origin into dirty/
  // checked snapshots so origin changes autosave and invalidate
  // verdicts exactly like text edits.
  const savedOrigin =
    savedDraft !== null && "summaryOrigin" in savedDraft ? savedDraft.summaryOrigin : "master";
  const currentSnapshot = useMemo(
    () =>
      draftSnapshot(summaryText, operations) +
      (planData !== null && planData.version === 2 ? `|${summaryOrigin}` : ""),
    [summaryText, operations, planData, summaryOrigin],
  );
  const savedSnapshot = useMemo(
    () =>
      savedDraft === null
        ? null
        : draftSnapshot(savedDraft.summaryText, savedDraft.operations) +
          (savedOrigin !== "master" || (planData !== null && planData.version === 2)
            ? `|${savedOrigin}`
            : ""),
    [savedDraft, savedOrigin, planData],
  );
  const buffersDirty =
    savedSnapshot === null
      ? summaryText !== "" || operations.length > 0
      : currentSnapshot !== savedSnapshot;

  const verdictIndex = useMemo(() => indexEditorSegments(verdicts), [verdicts]);
  const verdictsCurrent = verdicts !== null && checkedSnapshot === currentSnapshot;

  const employmentName = useCallback(
    (roleId: string): string => {
      const label = employmentLabel(payload, roleId);
      if (label !== null) {
        return `${label.company} — ${label.role}`;
      }
      return roleId === "" ? "Unlinked experience" : `Unknown role ${roleId}`;
    },
    [payload],
  );

  const addedBySuggestion = useMemo(() => {
    const added = new Map<string, Step2DraftOperationV1Type>();
    for (const op of operations) {
      if (op.op === "add" && !added.has(op.suggestionId)) {
        added.set(op.suggestionId, op);
      }
    }
    return added;
  }, [operations]);

  /* ---------------- validation ---------------- */

  const checkNow = useCallback(
    async (buffers: {
      summaryText: string;
      operations: EditorDraftOperation[];
    }): Promise<Step2ValidationV1Type | Step2ValidationV2Type | null> => {
      if (planData === null) {
        return null;
      }
      const planVersion = planData.version;
      const snapshot = draftSnapshot(buffers.summaryText, buffers.operations);
      // v2 folds the explicit summary origin into the checked
      // key exactly like currentSnapshot; without the suffix no
      // v2 verdict batch ever reads current. Staleness guards
      // below keep comparing the raw text/ops snapshot.
      const checkedKey =
        planVersion === 2 ? `${snapshot}|${summaryOrigin}` : snapshot;
      setCheckingCount((count) => count + 1);
      setValidateError(null);
      try {
        // v2 plans resolve through V-v2 with the explicit saved
        // origin; v1 plans keep V-v1 byte-for-byte.
        const requestBody =
          planVersion === 2
            ? {
                schemaVersion: STEP2_CORRECTION_VERSIONS.validateDraft,
                workspaceRevision: revisionRef.current,
                summaryText: buffers.summaryText,
                summaryOrigin,
                operations: buffers.operations,
              }
            : {
                schemaVersion: STEP2_SCHEMA_VERSIONS.validateDraft,
                workspaceRevision: revisionRef.current,
                summaryText: buffers.summaryText,
                operations: buffers.operations,
              };
        const response = await fetch(`/api/jobs/${jobId}/tailoring/draft/validate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody),
        });
        if (!response.ok) {
          const parsed = await parseTailoringError(response);
          if (draftSnapshot(buffersRef.current.summaryText, buffersRef.current.operations) !== snapshot) {
            return null;
          }
          setValidateError(parsed.message);
          return null;
        }
        const body = (await response.json()) as {
          validation?: Step2ValidationV1Type | Step2ValidationV2Type;
        };
        const replyVersion =
          body.validation?.schemaVersion === STEP2_CORRECTION_VERSIONS.validation ? 2 : 1;
        if (body.validation === undefined || replyVersion !== planVersion) {
          setValidateError("The validation reply is unreadable.");
          return null;
        }
        // Late responses apply only to the exact bytes they checked.
        if (draftSnapshot(buffersRef.current.summaryText, buffersRef.current.operations) !== snapshot) {
          return null;
        }
        setVerdicts(body.validation);
        setCheckedSnapshot(checkedKey);
        return body.validation;
      } catch (error) {
        if (draftSnapshot(buffersRef.current.summaryText, buffersRef.current.operations) !== snapshot) {
          return null;
        }
        setValidateError(error instanceof Error ? error.message : String(error));
        return null;
      } finally {
        setCheckingCount((count) => Math.max(0, count - 1));
      }
    },
    [jobId, planData, summaryOrigin],
  );

  /* ---------------- CAS autosave ---------------- */

  const saveNow = useCallback(
    async (buffers: { summaryText: string; operations: EditorDraftOperation[] }): Promise<boolean> => {
      const binding = prep?.binding ?? null;
      const planBinding =
        savedPlanBinding ?? (planData === null ? null : { planId: planData.plan.planId, planHash: planData.planHash });
      if (planBinding === null) {
        setSaveNote("Waiting for the accepted plan — edits are held, nothing is discarded.");
        return false;
      }
      if (planData !== null && planData.plan.planId !== planBinding.planId) {
        setSaveState("plan-stale");
        setSaveNote("A newer accepted plan arrived. Rebind before saving.");
        return false;
      }
      if (binding === null) {
        setSaveNote("Waiting for the captured profile binding.");
        return false;
      }
      const snapshot = draftSnapshot(buffers.summaryText, buffers.operations);
      // v2 plans save through W-v3 with the explicit summary
      // origin; v1 plans keep the W-v2 body byte-for-byte.
      const body: WorkspacePutV2Type | WorkspacePutV3Type =
        planData !== null && planData.version === 2
          ? {
              schemaVersion: STEP2_CORRECTION_VERSIONS.workspace,
              extractionId: activeExtractionId,
              profileId: binding.profileId,
              profileVersionId: binding.profileVersionId,
              requestKind: savedHeader.requestKind,
              parentVersionId: savedHeader.parentVersionId,
              revisionNote: savedHeader.revisionNote,
              planId: planBinding.planId,
              planHash: planBinding.planHash,
              recommendationHash: null,
              draft: {
                schemaVersion: STEP2_CORRECTION_VERSIONS.draft,
                planId: planBinding.planId,
                planHash: planBinding.planHash,
                summaryText: buffers.summaryText,
                summaryOrigin,
                operations: buffers.operations,
              },
            }
          : {
              schemaVersion: STEP2_SCHEMA_VERSIONS.workspace,
              extractionId: activeExtractionId,
              profileId: binding.profileId,
              profileVersionId: binding.profileVersionId,
              requestKind: savedHeader.requestKind,
              parentVersionId: savedHeader.parentVersionId,
              revisionNote: savedHeader.revisionNote,
              planId: planBinding.planId,
              planHash: planBinding.planHash,
              recommendationHash: null,
              draft: {
                schemaVersion: STEP2_SCHEMA_VERSIONS.draft,
                planId: planBinding.planId,
                planHash: planBinding.planHash,
                summaryText: buffers.summaryText,
                summarySource: summarySourceFor(buffers.summaryText, planData?.plan ?? null),
                operations: buffers.operations,
              },
            };
      setSaveState("saving");
      setSaveError(null);
      setSaveNote(null);
      setOpErrorIndex(null);
      try {
        const response = await fetch(`/api/jobs/${jobId}/tailoring/workspace`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "If-Match": buildWorkspaceETag(jobId, revisionRef.current),
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const parsed = await parseTailoringError(response);
          if (parsed.code === "WORKSPACE_CONFLICT") {
            setSaveState("conflict");
            setConflictRevision(parsed.currentWorkspaceRevision ?? null);
            setSaveError("Another session saved first. Your edits are kept below.");
            return false;
          }
          if (parsed.code === "PLAN_STALE") {
            setSaveState("plan-stale");
            setSaveNote(parsed.message);
            void reloadPlan();
            return false;
          }
          errorSnapshotRef.current = snapshot;
          setSaveState("error");
          setSaveError(parsed.message);
          setOpErrorIndex(operationIndexFromField(parsed.field));
          return false;
        }
        const reply = (await response.json()) as {
          workspace?: WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3 | null;
        };
        const view = reply.workspace ?? null;
        if (
          view === null ||
          (view.draft.schemaVersion !== "tailoring-workspace/v2" &&
            view.draft.schemaVersion !== "tailoring-workspace/v3")
        ) {
          setSaveState("error");
          setSaveError("The save reply is unreadable; reload before editing further.");
          return false;
        }
        setRevisionBoth(view.revision);
        setSavedHeader(headerFromWorkspace(view));
        setSavedPlanBinding(
          view.draft.planId === null
            ? null
            : { planId: view.draft.planId, planHash: view.draft.planHash as string },
        );
        setSavedDraft(view.draft.draft);
        setHasV1Stored(false);
        errorSnapshotRef.current = null;
        // Adopt server-collapsed ops only when the user did not type ahead.
        if (draftSnapshot(buffersRef.current.summaryText, buffersRef.current.operations) === snapshot) {
          setSummaryText(view.draft.draft?.summaryText ?? "");
          setOperations(view.draft.draft?.operations ?? []);
          if (view.draft.schemaVersion === "tailoring-workspace/v3") {
            setSummaryOrigin(view.draft.draft?.summaryOrigin ?? "master");
          }
          setSaveState("clean");
        } else {
          setSaveState("dirty");
        }
        void checkNow(buffersRef.current);
        return true;
      } catch (error) {
        errorSnapshotRef.current = snapshot;
        setSaveState("error");
        setSaveError(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    [jobId, prep, planData, savedPlanBinding, savedHeader, activeExtractionId, setRevisionBoth, checkNow, reloadPlan, summaryOrigin],
  );

  const saveNowRef = useRef(saveNow);
  useEffect(() => {
    saveNowRef.current = saveNow;
  });

  /* v2 seed: a fresh v2 draft opens on the master summary
   * (the default origin already names it) and saves revision 1
   * eagerly, so mount establishes the draft and Generate can
   * flush→submit without waiting out the debounce. Fires once,
   * only for pristine buffers with no saved draft; v1 keeps the
   * choose-a-starting-point UX byte-for-byte. Never clobbers
   * typed content or a reloaded draft. */
  useEffect(() => {
    if (prefilledRef.current) {
      return;
    }
    if (planData === null || planData.version !== 2 || planState !== "ready") {
      return;
    }
    prefilledRef.current = true;
    if (savedDraft !== null || revision !== 0) {
      return;
    }
    if (summaryText !== "" || operations.length > 0) {
      return;
    }
    const seed = planData.plan.positioning.keepMasterSummary;
    if (seed === "") {
      return;
    }
    // One-shot mount sync from loaded server data; the ref guard
    // above makes a render cascade impossible.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSummaryText(seed);
    saveChainRef.current = saveChainRef.current.then(() =>
      saveNowRef.current({ summaryText: seed, operations }),
    );
  }, [planData, planState, savedDraft, revision, summaryText, operations]);

  /* Debounced autosave: one in-flight PUT, error holds until buffers change. */
  useEffect(() => {
    if (prepState !== "ready" || profileState !== "ready" || planState === "loading") {
      return;
    }
    if (!buffersDirty) {
      return;
    }
    if (saveState === "conflict" || saveState === "plan-stale" || saveState === "saving") {
      return;
    }
    if (saveState === "error") {
      if (errorSnapshotRef.current === draftSnapshot(summaryText, operations)) {
        return;
      }
      errorSnapshotRef.current = null;
    }
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      const buffers = buffersRef.current;
      if (errorSnapshotRef.current === draftSnapshot(buffers.summaryText, buffers.operations)) {
        return;
      }
      saveChainRef.current = saveChainRef.current.then(() => saveNowRef.current(buffers));
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [prepState, profileState, planState, buffersDirty, summaryText, operations, saveState]);

  useEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
      }
    },
    [],
  );

  const flushSave = useCallback(async (): Promise<boolean> => {
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!buffersDirty) {
      return saveState !== "conflict" && saveState !== "plan-stale" && saveState !== "error";
    }
    const result = await saveNowRef.current(buffersRef.current);
    return result;
  }, [buffersDirty, saveState]);

  const reloadSaved = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/jobs/${jobId}/tailoring/workspace`);
      if (!response.ok) {
        setSaveError("Reload failed; your unsaved edits are still here.");
        return;
      }
      const body = (await response.json()) as {
        workspace?: WorkspaceView | WorkspaceViewV2 | WorkspaceViewV3 | null;
      };
      adoptWorkspaceView(body.workspace ?? null);
      setSaveState("clean");
      setSaveError(null);
      setConflictRevision(null);
      errorSnapshotRef.current = null;
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }, [jobId, adoptWorkspaceView]);

  const saveOverConflict = useCallback(async (): Promise<void> => {
    if (conflictRevision === null) {
      await reloadSaved();
      return;
    }
    setRevisionBoth(conflictRevision);
    setConflictRevision(null);
    setSaveState("dirty");
    errorSnapshotRef.current = null;
    await saveNowRef.current(buffersRef.current);
  }, [conflictRevision, reloadSaved, setRevisionBoth]);

  const rebindToPlan = useCallback(async (): Promise<void> => {
    const next = await reloadPlan();
    if (next === null) {
      setSaveNote("No accepted plan is available yet.");
      return;
    }
    setSavedPlanBinding({ planId: next.plan.planId, planHash: next.planHash });
    setSaveState("dirty");
    setSaveNote(null);
    errorSnapshotRef.current = null;
    await saveNowRef.current(buffersRef.current);
  }, [reloadPlan]);

  /* ---------------- explicit preparation / retry (never on navigation) ---------------- */

  const refreshJobRowVersion = useCallback(async (): Promise<number> => {
    try {
      const response = await fetch(`/api/jobs/${jobId}`);
      if (!response.ok) {
        return jobRowVersion;
      }
      const body = (await response.json()) as { job?: { rowVersion?: unknown } };
      if (typeof body.job?.rowVersion === "number") {
        setJobRowVersion(body.job.rowVersion);
        return body.job.rowVersion;
      }
    } catch {
      // Fall through with the last known version; the server CAS reports drift.
    }
    return jobRowVersion;
  }, [jobId, jobRowVersion]);

  const ensureProfilesList = useCallback(async (): Promise<ProfilesListItem[] | null> => {
    if (profilesList !== null) {
      return profilesList;
    }
    try {
      const response = await fetch("/api/settings/profiles");
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { profiles?: ProfilesListItem[] };
      if (!Array.isArray(body.profiles)) {
        return null;
      }
      setProfilesList(body.profiles);
      return body.profiles;
    } catch {
      return null;
    }
  }, [profilesList]);

  const runPreparation = useCallback(async (): Promise<void> => {
    setPreparing(true);
    setPrepActionError(null);
    try {
      const profiles = await ensureProfilesList();
      const fallback = profiles?.find((entry) => entry.isDefault) ?? null;
      if (fallback === null) {
        setPrepActionError("No default profile is selected in Settings.");
        return;
      }
      const observedRowVersion = await refreshJobRowVersion();
      const response = await fetch(`/api/jobs/${jobId}/tailoring/preparation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: STEP2_SCHEMA_VERSIONS.prepareCommand,
          operationId: randomOperationId(),
          observedRowVersion,
          profileId: fallback.id,
        }),
      });
      if (!response.ok) {
        const parsed = await parseTailoringError(response);
        setPrepActionError(parsed.message);
        if (typeof parsed.currentRowVersion === "number") {
          setJobRowVersion(parsed.currentRowVersion);
        }
        return;
      }
      await reloadPreparation();
    } catch (error) {
      setPrepActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparing(false);
    }
  }, [jobId, ensureProfilesList, refreshJobRowVersion, reloadPreparation]);

  const retryPreparation = useCallback(async (): Promise<void> => {
    if (prep?.attemptId === null || prep?.attemptId === undefined) {
      setPrepActionError("No failed attempt is available to retry.");
      return;
    }
    setPreparing(true);
    setPrepActionError(null);
    try {
      const observedRowVersion = await refreshJobRowVersion();
      const response = await fetch(`/api/jobs/${jobId}/tailoring/preparation/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: STEP2_SCHEMA_VERSIONS.prepareRetry,
          observedAttemptId: prep.attemptId,
          observedRowVersion,
        }),
      });
      if (!response.ok) {
        const parsed = await parseTailoringError(response);
        setPrepActionError(parsed.message);
        if (typeof parsed.currentRowVersion === "number") {
          setJobRowVersion(parsed.currentRowVersion);
        }
        return;
      }
      await reloadPreparation();
    } catch (error) {
      setPrepActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparing(false);
    }
  }, [jobId, prep, refreshJobRowVersion, reloadPreparation]);

  const employments = useMemo(() => payload?.employment ?? [], [payload]);

  /**
   * Roles the UI exposes for a suggestion. v1 plans keep every
   * payload employment; v2 plans expose ONLY the server-derived
   * eligible set (fail closed on unknown suggestions — the save
   * service remains the authoritative backstop).
   */
  const rolesForSuggestion = useCallback(
    (suggestionId: string): Array<{ id: string; company: string; role: string }> => {
      if (planData === null || planData.version !== 2) {
        return employments;
      }
      const allowed = planData.eligibleRoles.get(suggestionId);
      if (allowed === undefined) {
        return [];
      }
      return employments.filter((entry) => allowed.includes(entry.id));
    },
    [planData, employments],
  );

  /**
   * Roles for suggestion-less rows (replace-with-text): mirrors
   * the §7.3 single-anchor rule over the captured payload —
   * owned facts stay in their employment, transferable facts may
   * target any employment, unknown facts fail closed. The server
   * re-derives this independently at save/submit.
   */
  const rolesForFact = useCallback(
    (factId: string): Array<{ id: string; company: string; role: string }> => {
      if (planData === null || planData.version !== 2) {
        return employments;
      }
      const achievement = payload?.achievements.find((entry) => entry.factId === factId);
      if (achievement === undefined) {
        return [];
      }
      if (achievement.employmentId === undefined) {
        return employments;
      }
      return employments.filter((entry) => entry.id === achievement.employmentId);
    },
    [planData, employments, payload],
  );

  /** Roles for one rendered row (suggestion rows use the server map). */
  const rolesForRow = useCallback(
    (row: AppliedBulletRow): Array<{ id: string; company: string; role: string }> => {
      if (row.suggestionId !== null) {
        return rolesForSuggestion(row.suggestionId);
      }
      if (row.factId !== null) {
        return rolesForFact(row.factId);
      }
      return employments;
    },
    [rolesForSuggestion, rolesForFact, employments],
  );

  /* ---------------- draft mutations (local buffers; autosave persists) ---------------- */

  const removeOperation = useCallback(
    (operationId: string): void => {
      const removed = operations.find((op) => op.operationId === operationId);
      if (removed !== undefined && editBuffer !== null) {
        const [kind, id] = editBuffer.key.split(":", 2);
        const touches =
          kind === "suggestion"
            ? (removed.op === "add" && removed.suggestionId === id) ||
              (removed.op === "replace" && removed.suggestionId === id) ||
              (removed.op === "edit" &&
                removed.target.kind === "suggestion" &&
                removed.target.suggestionId === id)
            : kind === "bullet"
              ? (removed.op === "replace" && removed.targetFactId === id) ||
                (removed.op === "exclude" && removed.targetFactId === id) ||
                (removed.op === "edit" &&
                  removed.target.kind === "bullet" &&
                  removed.target.factId === id)
              : false;
        if (touches) {
          setEditBuffer(null);
        }
      }
      setOperations((current) => current.filter((op) => op.operationId !== operationId));
    },
    [operations, editBuffer],
  );

  const addSuggestion = useCallback(
    (suggestionId: string, roleId: string): void => {
      if (
        planData !== null &&
        planData.version === 2 &&
        !rolesForSuggestion(suggestionId).some((entry) => entry.id === roleId)
      ) {
        setDndError(
          `That role cannot take this suggestion — choose one of the eligible roles. The server enforces the same rule.`,
        );
        return;
      }
      setOperations((current) => {
        if (current.some((op) => op.op === "add" && op.suggestionId === suggestionId && op.roleId === roleId)) {
          return current;
        }
        return [
          ...current,
          {
            op: "add",
            operationId: randomOperationId(),
            suggestionId,
            roleId,
            editedText: null,
          } satisfies EditorDraftOperation,
        ];
      });
    },
    [planData, rolesForSuggestion],
  );

  const replaceWithSuggestion = useCallback(
    (suggestionId: string, targetFactId: string, roleId: string): void => {
      setOperations((current) => [
        ...current,
        {
          op: "replace",
          operationId: randomOperationId(),
          targetFactId,
          roleId,
          suggestionId,
          editedText: null,
        } satisfies Step2DraftOperationV1Type,
      ]);
      setReplaceFor(null);
    },
    [],
  );

  const excludeBullet = useCallback((targetFactId: string): void => {
    setOperations((current) => {
      if (current.some((op) => op.op === "exclude" && op.targetFactId === targetFactId)) {
        return current;
      }
      return [
        ...current,
        { op: "exclude", operationId: randomOperationId(), targetFactId } satisfies Step2DraftOperationV1Type,
      ];
    });
  }, []);

  const saveEditBuffer = useCallback((): void => {
    if (editBuffer === null) {
      return;
    }
    const text = editBuffer.text.trim();
    if (text === "") {
      return;
    }
    const [kind, id] = editBuffer.key.split(":", 2) as [
      "suggestion" | "bullet" | "instance",
      string,
    ];
    // Instance edits resolve to their host suggestion id; the
    // saved op shape is unchanged (an edit targeting the
    // suggestion). A host removed mid-edit drops the buffer
    // instead of guessing.
    const host = operations.find((op) => op.operationId === id);
    const resolvedId =
      kind === "instance"
        ? host !== undefined && (host.op === "add" || host.op === "replace")
          ? (host.suggestionId ?? null)
          : null
        : id;
    if (resolvedId === null) {
      setEditBuffer(null);
      return;
    }
    setOperations((current) => {
      if (kind === "bullet") {
        const existing = current.findIndex(
          (op) => op.op === "edit" && op.target.kind === "bullet" && op.target.factId === resolvedId,
        );
        const op = {
          op: "edit",
          operationId:
            existing >= 0
              ? (current[existing] as Extract<Step2DraftOperationV1Type, { op: "edit" }>).operationId
              : randomOperationId(),
          target: { kind: "bullet", factId: resolvedId },
          text,
        } satisfies Step2DraftOperationV1Type;
        if (existing >= 0) {
          const next = [...current];
          next[existing] = op;
          return next;
        }
        return [...current, op];
      }
      const addedInstance = current.some(
        (op) =>
          (op.op === "add" && op.suggestionId === resolvedId) ||
          (op.op === "replace" && op.suggestionId === resolvedId),
      );
      if (!addedInstance) {
        return [
          ...current,
          {
            op: "add",
            operationId: randomOperationId(),
            suggestionId: resolvedId,
            roleId: plan?.suggestions.find((suggestion) => suggestion.suggestionId === resolvedId)?.roleId ?? "",
            editedText: text,
          } satisfies Step2DraftOperationV1Type,
        ];
      }
      const existing = current.findIndex(
        (op) => op.op === "edit" && op.target.kind === "suggestion" && op.target.suggestionId === resolvedId,
      );
      const op = {
        op: "edit",
        operationId:
          existing >= 0
            ? (current[existing] as Extract<Step2DraftOperationV1Type, { op: "edit" }>).operationId
            : randomOperationId(),
        target: { kind: "suggestion", suggestionId: resolvedId },
        text,
      } satisfies Step2DraftOperationV1Type;
      if (existing >= 0) {
        const next = [...current];
        next[existing] = op;
        return next;
      }
      return [...current, op];
    });
    setEditBuffer(null);
  }, [editBuffer, plan, operations]);

  const moveInstance = useCallback(
    (roleId: string, operationId: string, direction: -1 | 1): void => {
      const peers = operations.filter(
        (op) => (op.op === "add" || op.op === "replace") && op.roleId === roleId,
      );
      const at = peers.findIndex((op) => op.operationId === operationId);
      const neighbor = peers[at + direction];
      if (at < 0 || neighbor === undefined) {
        return;
      }
      setOperations((current) => {
        const left = current.findIndex((op) => op.operationId === operationId);
        const right = current.findIndex((op) => op.operationId === neighbor.operationId);
        if (left < 0 || right < 0) {
          return current;
        }
        const next = [...current];
        const held = next[left] as Step2DraftOperationV1Type;
        next[left] = next[right] as Step2DraftOperationV1Type;
        next[right] = held;
        return next;
      });
    },
    [operations],
  );

  const moveOperationToRole = useCallback(
    (operationId: string, roleId: string): void => {
      if (planData !== null && planData.version === 2) {
        const target = operations.find((op) => op.operationId === operationId);
        const suggestionId =
          target !== undefined && (target.op === "add" || target.op === "replace")
            ? target.suggestionId
            : null;
        const allowed =
          suggestionId !== null
            ? rolesForSuggestion(suggestionId)
            : target !== undefined && target.op === "replace"
              ? rolesForFact(target.targetFactId)
              : employments;
        if (!allowed.some((entry) => entry.id === roleId)) {
          setDndError(
            `That role cannot take this bullet — move it to an eligible role. The server enforces the same rule.`,
          );
          return;
        }
      }
      setOperations((current) =>
        current.map((op) =>
          op.operationId === operationId && (op.op === "add" || op.op === "replace")
            ? { ...op, roleId }
            : op,
        ),
      );
    },
    [planData, operations, rolesForSuggestion, rolesForFact, employments],
  );

  const applyTheme = useCallback(
    (source: SummarySource): void => {
      if (plan === null) {
        return;
      }
      const saved = savedDraft?.summaryText ?? "";
      if (summaryText !== saved) {
        setThemeConfirm(source);
        return;
      }
      if (planData !== null && planData.version === 2 && source !== "edited") {
        setSummaryOrigin(source);
      }
      if (source === "master") {
        setSummaryText(plan.positioning.keepMasterSummary);
      } else {
        const angle = plan.positioning.angles.find((entry) => entry.angleId === source);
        if (angle !== undefined) {
          setSummaryText(angle.summaryText);
        }
      }
    },
    [plan, planData, savedDraft, summaryText],
  );

  const confirmTheme = useCallback((): void => {
    if (themeConfirm === null || plan === null) {
      setThemeConfirm(null);
      return;
    }
    if (planData !== null && planData.version === 2 && themeConfirm !== "edited") {
      setSummaryOrigin(themeConfirm);
    }
    if (themeConfirm === "master") {
      setSummaryText(plan.positioning.keepMasterSummary);
    } else {
      const angle = plan.positioning.angles.find((entry) => entry.angleId === themeConfirm);
      if (angle !== undefined) {
        setSummaryText(angle.summaryText);
      }
    }
    setThemeConfirm(null);
  }, [themeConfirm, plan, planData]);

  /* ---------------- render ---------------- */

  const featuredPriorities = useMemo(() => {
    if (plan === null) {
      return [];
    }
    const byId = new Map(plan.priorities.map((priority) => [priority.priorityId, priority]));
    return plan.featuredPriorityIds
      .map((id) => byId.get(id))
      .filter((priority): priority is NonNullable<typeof priority> => priority !== undefined);
  }, [plan]);
  const remainingPriorities = useMemo(() => {
    if (plan === null) {
      return [];
    }
    const featured = new Set(plan.featuredPriorityIds);
    return plan.priorities.filter((priority) => !featured.has(priority.priorityId));
  }, [plan]);

  const usableSuggestions = useMemo(
    () => (plan?.suggestions ?? []).filter((suggestion) => suggestion.usable && !skipped.has(suggestion.suggestionId)),
    [plan, skipped],
  );
  const skippedSuggestions = useMemo(
    () => (plan?.suggestions ?? []).filter((suggestion) => suggestion.usable && skipped.has(suggestion.suggestionId)),
    [plan, skipped],
  );
  const unusableSuggestions = useMemo(
    () => (plan?.suggestions ?? []).filter((suggestion) => !suggestion.usable),
    [plan],
  );

  const currentSource = summarySourceFor(summaryText, plan);
  const isV2Plan = planData !== null && planData.version === 2;
  const originLabel =
    summaryOrigin === "master" ? "Master" : summaryOrigin === "angle-2" ? "AI Angle 2" : "AI Angle 1";
  const summaryEdited = matchSummaryOrigin(summaryText, plan) === null && summaryText !== "";
  /** v2 priority quotes addressed by one proposal's links (v1 proposals carry none). */
  const quotesForLinks = useCallback(
    (priorityIds: string[] | undefined): string[] => {
      if (planData === null || planData.version !== 2 || priorityIds === undefined) {
        return [];
      }
      const byId = new Map(planData.plan.priorities.map((priority) => [priority.priorityId, priority]));
      return priorityIds.flatMap((id) => {
        const found = byId.get(id);
        return found === undefined ? [] : [found.quote.text];
      });
    },
    [planData],
  );
  const draftEnabled = planData !== null && prepState === "ready" && profileState === "ready";

  const segmentBadge = (segmentIds: Array<string | null>): ReactNode => {
    if (!verdictsCurrent) {
      if (checking) {
        return <Badge variant="secondary">Checking…</Badge>;
      }
      return verdicts === null ? (
        <Badge variant="outline">Not checked yet</Badge>
      ) : (
        <Badge variant="secondary">Checking…</Badge>
      );
    }
    let found: EditorSegmentState | undefined;
    for (const id of segmentIds) {
      if (id !== null) {
        const candidate = verdictIndex.get(id);
        if (candidate !== undefined) {
          found = candidate;
          break;
        }
      }
    }
    if (found === undefined) {
      return <Badge variant="outline">Not checked</Badge>;
    }
    // v1 keeps Supported/Needs-evidence; v2 shows provenance
    // (Verified source / AI suggestion · accepted / User edit)
    // with structural blocks only — user edits never display an
    // evidence blocker.
    if (found.blocked) {
      return (
        <Badge variant="destructive" title={found.title}>
          {found.badge}
        </Badge>
      );
    }
    if (found.provenance === "VERIFIED_SOURCE" || found.badge === "Verified source") {
      return (
        <Badge
          variant="outline"
          className="border-emerald-500/30 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-400 inline-flex items-center"
          title={found.title}
        >
          <ShieldCheck className="mr-1 inline h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <span>Verified source</span>
        </Badge>
      );
    }
    if (found.provenance === "USER_ACCEPTED_AI" || found.badge === "AI suggestion · accepted") {
      return (
        <Badge
          variant="outline"
          className="border-purple-500/30 bg-purple-500/10 font-medium text-purple-700 dark:text-purple-400 inline-flex items-center"
          title={found.title}
        >
          <Sparkles className="mr-1 inline h-3 w-3 text-purple-600 dark:text-purple-400" aria-hidden="true" />
          <span>AI suggestion · accepted</span>
        </Badge>
      );
    }
    if (found.provenance === "USER_EDITED" || found.badge === "User edit") {
      return (
        <Badge
          variant="outline"
          className="border-sky-500/30 bg-sky-500/10 font-medium text-sky-700 dark:text-sky-400 inline-flex items-center"
          title={found.title}
        >
          <Edit2 className="mr-1 inline h-3 w-3 text-sky-600 dark:text-sky-400" aria-hidden="true" />
          <span>User edit</span>
        </Badge>
      );
    }
    return (
      <Badge variant="secondary" title={found.title}>
        {found.badge}
      </Badge>
    );
  };

  const displaySaveState: SaveState =
    saveState === "conflict" || saveState === "plan-stale" || saveState === "error"
      ? saveState
      : saveState === "saving"
        ? "saving"
        : buffersDirty
          ? "dirty"
          : "clean";

  const saveStatusText = (): string => {
    switch (displaySaveState) {
      case "clean":
        return revision > 0 ? `Saved · revision ${revision}` : "Saved";
      case "dirty":
        return "Unsaved changes";
      case "saving":
        return "Saving…";
      case "conflict":
        return `Conflict · server is at revision ${conflictRevision ?? "?"}`;
      case "plan-stale":
        return "Plan changed · rebind to save";
      case "error":
        return "Save failed";
    }
  };

  /* ---------------- explicit generation (one primary exit) ---------------- */

  const goToStep3 = useCallback((): void => {
    // The submit stamps a new workspace revision, bumps the job
    // row, and queues live work: reload so the server resolver
    // rebuilds Step 3 (progress), versions, and CAS state from
    // truth. Navigate first so the step is honest even if the
    // reload is somehow skipped.
    onNavigateStep(3);
    const url = new URL(window.location.href);
    url.searchParams.set("step", "3");
    window.location.assign(url.toString());
  }, [onNavigateStep]);

  const postGeneration = useCallback(
    async (body: PendingGeneration): Promise<boolean> => {
      let response: Response;
      try {
        response = await fetch(`/api/jobs/${jobId}/tailoring/generations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        // Network loss: the run may or may not exist. Keep the
        // exact bytes for replay; never mint a second operation.
        setPendingGen(body);
        setGenerateError(
          `The submission may not have reached the server (${error instanceof Error ? error.message : String(error)}). Replay it or discard it below.`,
        );
        return false;
      }
      if (response.ok) {
        clearPendingGeneration(jobId);
        setPendingGen(null);
        setGenerateError(null);
        goToStep3();
        return true;
      }
      const parsed = await parseTailoringError(response);
      clearPendingGeneration(jobId);
      setPendingGen(null);
      switch (parsed.code) {
        case "PLAN_STALE":
          setSaveState("plan-stale");
          setSaveNote(parsed.message);
          setGenerateError(null);
          return false;
        case "WORKSPACE_CONFLICT":
          setSaveState("conflict");
          setConflictRevision(parsed.currentWorkspaceRevision ?? null);
          setSaveError(parsed.message);
          setGenerateError(null);
          return false;
        case "JOB_CONFLICT":
          if (parsed.currentRowVersion !== undefined) {
            setJobRowVersion(parsed.currentRowVersion);
          }
          setGenerateError(`${parsed.message} Reload and resubmit.`);
          return false;
        case "GENERATION_BUSY":
          setGenerateError(`${parsed.message} Reload to follow the live run.`);
          return false;
        case "UNRESOLVED_EVIDENCE":
        case "BUDGET_EXCEEDED":
          setGenerateError(parsed.message);
          void checkNow(buffersRef.current);
          return false;
        default:
          setGenerateError(parsed.message);
          return false;
      }
    },
    [checkNow, goToStep3, jobId],
  );

  const submitGeneration = useCallback(async (): Promise<void> => {
    if (generateState === "working") {
      return;
    }
    setGenerateState("working");
    setGenerateError(null);
    try {
      const flushed = await flushSave();
      if (!flushed) {
        return;
      }
      const validation = await checkNow(buffersRef.current);
      if (validation === null) {
        return;
      }
      const blocked = [...indexEditorSegments(validation).values()].filter(
        (segment) => segment.blocked,
      );
      if (blocked.length > 0) {
        const names = blocked
          .slice(0, 3)
          .map((segment) =>
            segment.blockReason === null
              ? segment.segmentId
              : `${segment.segmentId} (${segment.blockReason})`,
          )
          .join(", ");
        // v1 blocks unsupported evidence; v2 blocks structural
        // failures only — USER_EDITED never blocks Generate.
        setGenerateError(
          planData !== null && planData.version === 2
            ? `Resolve ${blocked.length} structural ${blocked.length === 1 ? "segment" : "segments"} first: ${names}.`
            : `Resolve ${blocked.length} unsupported ${blocked.length === 1 ? "segment" : "segments"} first: ${names}. Edit to supported wording or exclude.`,
        );
        return;
      }
      // Length guidance is advisory: an exceeded bullet/summary
      // count never stops submission. Every kept bullet generates
      // as is; the Resume length notice above says so before submit.
      const rowVersion = await refreshJobRowVersion();
      const body: PendingGeneration = {
        schemaVersion: TAILORING_SUBMIT_SCHEMA_VERSION,
        requestId: randomOperationId(),
        workspaceRevision: revisionRef.current,
        observedRowVersion: rowVersion,
      };
      writePendingGeneration(jobId, body);
      await postGeneration(body);
    } finally {
      setGenerateState("idle");
    }
  }, [checkNow, flushSave, generateState, jobId, planData, postGeneration, refreshJobRowVersion]);

  const replayPendingGeneration = useCallback(async (): Promise<void> => {
    if (pendingGen === null || generateState === "working") {
      return;
    }
    setGenerateState("working");
    setGenerateError(null);
    try {
      // Byte-identical replay: the same operation id and bytes, so
      // the server converges instead of forking a second run.
      await postGeneration(pendingGen);
    } finally {
      setGenerateState("idle");
    }
  }, [generateState, pendingGen, postGeneration]);

  const discardPendingGeneration = useCallback((): void => {
    clearPendingGeneration(jobId);
    setPendingGen(null);
    setGenerateError(null);
  }, [jobId]);

  const generateDisabledReason = !draftEnabled
    ? "Prepare a plan first."
    : !canGenerate
      ? "Generation is unavailable while a run is live."
      : revision === 0
        ? "Save the draft first."
        : saveState === "conflict"
          ? "Resolve the save conflict first."
          : saveState === "plan-stale"
            ? "Rebind to the new plan first."
            : null;

  return (
    <section aria-labelledby="step2-heading" className="space-y-6">
      <div className="flex items-center justify-between border-b border-border/60 pb-4">
        <div>
          <h2 id="step2-heading" className="text-xl font-bold tracking-tight">
            Choose focus
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Edit the prepared plan. Master content never changes here.
          </p>
        </div>
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {saveStatusText()}
        </p>
      </div>

      {hasV1Stored && (
        <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/40 p-3 text-xs">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p>
            This job has a previous-format draft. It stays untouched until you save here — the
            first save starts a new edited plan and replaces it.
          </p>
        </div>
      )}
      {displaySaveState === "conflict" && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {saveError ?? "Save conflict."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void reloadSaved()}>
              <RotateCcw className="mr-1 h-3 w-3" aria-hidden="true" />
              Reload saved draft
            </Button>
            <Button type="button" size="sm" onClick={() => void saveOverConflict()}>
              Save my version over revision {conflictRevision ?? "?"}
            </Button>
          </div>
        </div>
      )}
      {displaySaveState === "plan-stale" && (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {saveNote ?? "The accepted plan changed."} Your edits are kept.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => void rebindToPlan()}>
              <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
              Rebind to the new plan and save
            </Button>
          </div>
          <p className="text-muted-foreground">
            Operations the new plan rejects are reported per bullet, never dropped silently.
          </p>
        </div>
      )}
      {displaySaveState === "error" && saveError !== null && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="flex-1">
            <p className="font-medium">Save failed: {saveError}</p>
            <p className="mt-1 text-muted-foreground">
              Fix the flagged item, then keep editing — saving resumes automatically.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              errorSnapshotRef.current = null;
              setSaveState("dirty");
              setSaveError(null);
              void saveNowRef.current(buffersRef.current);
            }}
          >
            Retry save
          </Button>
        </div>
      )}
      {saveNote !== null && displaySaveState !== "plan-stale" && displaySaveState !== "conflict" && (
        <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/40 p-3 text-xs">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p>{saveNote}</p>
        </div>
      )}
      {validateError !== null && (
        <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/40 p-3 text-xs">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex-1">
            <p>Support check: {validateError}</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void checkNow(buffersRef.current)}
          >
            Check again
          </Button>
        </div>
      )}

      {/* Captured profile and Preparation context strip */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Captured profile */}
        <div className="rounded-lg border border-border/60 bg-card p-4 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Captured profile
              </h3>
              {profileState === "ready" && profileData !== null && (
                <Badge variant="outline" className="border-border/60 text-muted-foreground text-[11px]">
                  Immutable snapshot
                </Badge>
              )}
            </div>
            {profileState === "loading" && (
              <p className="mt-2 text-xs text-muted-foreground">Loading captured profile…</p>
            )}
            {profileState === "error" && (
              <p className="mt-2 text-xs text-destructive">{profileError ?? "Profile unavailable."}</p>
            )}
            {profileState === "ready" && profileData === null && (
              <p className="mt-2 text-xs text-muted-foreground">
                No profile is captured yet. Run preparation to capture the default profile.
              </p>
            )}
            {profileState === "ready" && profileData !== null && (
              <div className="mt-2 space-y-2">
                <p className="text-sm font-semibold text-foreground">
                  {profileData.profile.displayName} · v{profileData.version.version}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => setPreviewOpen(true)}>
                    <Eye className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    Preview
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => openSettings("profile", profileData.profile.id)}
                  >
                    <Edit2 className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    Edit profile
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Settings edits apply to future intake only — this job keeps v{profileData.version.version}.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Preparation */}
        <div className="rounded-lg border border-border/60 bg-card p-4 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Preparation
              </h3>
              {prepState === "ready" && prep !== null && (
                <Badge
                  variant="outline"
                  className={cn(
                    "text-[11px] font-medium inline-flex items-center gap-1",
                    prep.state === "SUCCEEDED" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                    prep.state === "FAILED" && "border-destructive/40 bg-destructive/10 text-destructive",
                    (prep.state === "RUNNING" || prep.state === "QUEUED" || prep.state === "PENDING") && "border-primary/30 bg-primary/10 text-primary",
                  )}
                >
                  {prep.state === "SUCCEEDED" && <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
                  {prep.state === "RUNNING" && <Loader2 className="h-3 w-3 animate-spin text-primary" aria-hidden="true" />}
                  <span>{preparationLabel(prep.state)}</span>
                </Badge>
              )}
            </div>
            {prepState === "loading" && (
              <p className="mt-2 text-xs text-muted-foreground">Loading preparation…</p>
            )}
            {prepState === "error" && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                <p className="text-destructive">{prepError ?? "Preparation unavailable."}</p>
                <Button type="button" size="sm" variant="outline" onClick={() => void reloadPreparation()}>
                  Retry
                </Button>
              </div>
            )}
            {prepState === "ready" && prep !== null && (
              <div className="mt-2 space-y-2 text-xs">
                {(prep.state === "PENDING" || prep.state === "QUEUED" || prep.state === "RUNNING") && (
                  <div>
                    {prep.events.length === 0 ? (
                      <p className="text-muted-foreground">Waiting for the worker to report stages…</p>
                    ) : (
                      <ol className="list-decimal space-y-1 pl-5">
                        {prep.events.map((event) => (
                          <li key={event.seq}>
                            {stageLabel(event.stage)}{" "}
                            <span className="text-muted-foreground">
                              ({event.source === "cached" ? "recovered" : "live"})
                            </span>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
                {prep.state === "SUCCEEDED" && (
                  <p className="text-muted-foreground">The accepted plan is ready below.</p>
                )}
                {prep.state === "FAILED" && (
                  <div className="space-y-2">
                    <p>
                      {prep.failure === null
                        ? "Preparation failed."
                        : `Failed: ${prep.failure.code}. ${failureHint(prep.failure.action) ?? ""}`}
                      {prep.failure?.retryAfterSeconds !== null &&
                        prep.failure?.retryAfterSeconds !== undefined &&
                        prep.failure.retryAfterSeconds > 0 && (
                          <span> Retry in {prep.failure.retryAfterSeconds} s.</span>
                        )}
                    </p>
                    {prep.binding?.batchId !== null && prep.binding?.batchId !== undefined ? (
                      <p>
                        <a
                          className="inline-flex items-center gap-1 text-primary underline font-medium"
                          href={`/intake/batches/${prep.binding.batchId}`}
                        >
                          Open batch diagnostics
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </a>{" "}
                        <span className="text-muted-foreground">to retry from there.</span>
                      </p>
                    ) : prep.retryAllowed ? (
                      <Button type="button" size="sm" onClick={() => void retryPreparation()} disabled={preparing}>
                        {preparing ? (
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                        ) : (
                          <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
                        )}
                        Retry preparation
                      </Button>
                    ) : (
                      <p className="text-muted-foreground">This failure cannot be retried.</p>
                    )}
                  </div>
                )}
                {prep.state === "ABSENT" && (
                  <div className="space-y-2">
                    <p className="text-muted-foreground">
                      Preparation has not run for this job. Running it captures the default
                      profile and prepares a plan.
                    </p>
                    <Button type="button" size="sm" onClick={() => void runPreparation()} disabled={preparing}>
                      {preparing ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" aria-hidden="true" />
                      ) : (
                        <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
                      )}
                      Run preparation
                    </Button>
                  </div>
                )}
                {prepActionError !== null && <p className="text-destructive">{prepActionError}</p>}
                {prep.binding?.batchId !== null &&
                  prep.binding?.batchId !== undefined &&
                  prep.state !== "FAILED" && (
                    <p>
                      <a
                        className="inline-flex items-center gap-1 text-primary underline font-medium"
                        href={`/intake/batches/${prep.binding.batchId}`}
                      >
                        Batch diagnostics
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                    </p>
                  )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 1. Priorities / Important phrases */}
      <div className="rounded-lg border border-border/60 bg-card p-5 shadow-sm space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold tracking-tight text-foreground">Important phrases</h3>
          <p className="text-xs text-muted-foreground">
            Key priorities and phrases extracted from the job description with master profile support.
          </p>
        </div>
        {planState === "loading" && (
          <p className="mt-2 text-xs text-muted-foreground">Loading plan…</p>
        )}
        {planState === "missing" && (
          <p className="mt-2 text-xs text-muted-foreground">
            No accepted plan yet. Phrases appear once preparation succeeds.
          </p>
        )}
        {planState === "error" && (
          <div className="mt-2 flex items-center gap-2 text-xs">
            <p className="text-destructive">{planError ?? "Plan unavailable."}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void reloadPlan()}>
              Retry
            </Button>
          </div>
        )}
        {planState === "ready" && plan !== null && (
          <div className="mt-3 space-y-3">
            {featuredPriorities.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No standout phrases — the description is sparse, so nothing is padded in.
              </p>
            )}
            <ul className="space-y-2">
              {featuredPriorities.map((priority) => (
                <li
                  key={priority.priorityId}
                  className="rounded-lg border border-border/50 bg-background/50 p-3 text-xs shadow-xs hover:border-border/80 transition-colors"
                >
                  <p className="flex flex-wrap items-center gap-2">
                    {renderSupportBadge(priority.support)}
                    <span className="font-semibold text-foreground">{priority.quote.text}</span>
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {priority.importance} · mentioned {priority.count}× · {priority.category}
                  </p>
                  <details className="group mt-2 rounded-md border border-border/40 bg-muted/20 p-2 text-xs">
                    <summary className="cursor-pointer font-medium text-primary hover:underline select-none">
                      Source and evidence
                    </summary>
                    <p className="mt-1.5 flex items-start gap-1 text-muted-foreground">
                      <Quote className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                      <span>
                        “{priority.quote.text}” (description bytes {priority.quote.startByte}–
                        {priority.quote.endByte})
                      </span>
                    </p>
                    {priority.factIds.length === 0 ? (
                      <p className="mt-1.5 text-muted-foreground">No supporting evidence.</p>
                    ) : (
                      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
                        {priority.factIds.map((factId) => {
                          const achievement = payload?.achievements.find(
                            (entry) => entry.factId === factId,
                          );
                          return (
                            <li key={factId}>
                              <span className="font-mono text-[11px] bg-muted/60 px-1 py-0.5 rounded border border-border/40">{factId}</span>
                              {achievement !== undefined && <span>: {achievement.text}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </details>
                </li>
              ))}
            </ul>
            {remainingPriorities.length > 0 && (
              <details className="mt-3 rounded-lg border border-border/50 bg-muted/10 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-primary hover:underline select-none">
                  All requirements ({plan.priorities.length})
                </summary>
                <ul className="mt-2.5 space-y-2">
                  {remainingPriorities.map((priority) => (
                    <li
                      key={priority.priorityId}
                      className="rounded-lg border border-border/40 bg-background/50 p-2.5 text-xs"
                    >
                      <p className="flex flex-wrap items-center gap-2">
                        {renderSupportBadge(priority.support)}
                        <span className="font-medium text-foreground">{priority.quote.text}</span>
                      </p>
                      <p className="mt-1 text-muted-foreground">
                        {priority.importance} · mentioned {priority.count}× · {priority.category}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      {/* 2. Positioning and summary */}
      <div className="rounded-lg border border-border/60 bg-card p-5 shadow-sm space-y-4">
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold tracking-tight text-foreground">Positioning</h3>
          <p className="text-xs text-muted-foreground">
            Select a strategic positioning angle, or keep your master resume summary, then refine the wording.
          </p>
        </div>
        {planState !== "ready" || plan === null ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Positioning options appear with the accepted plan.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              {/* Keep master card */}
              {(() => {
                const isMasterSelected = summaryOrigin === "master" && !summaryEdited;
                return (
                  <div
                    className={cn(
                      "rounded-lg border p-3.5 text-xs flex flex-col justify-between transition-all",
                      isMasterSelected
                        ? "border-primary/60 bg-primary/5 ring-1 ring-primary/20 shadow-xs"
                        : "border-border/60 bg-background/50 hover:border-border/80",
                    )}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-foreground text-sm">Keep master</span>
                        {isMasterSelected && (
                          <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary text-[11px]">
                            Current
                          </Badge>
                        )}
                      </div>
                      <p className="mt-2 text-muted-foreground leading-relaxed">
                        {plan.positioning.keepMasterSummary === ""
                          ? "The master has no summary."
                          : plan.positioning.keepMasterSummary}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={isMasterSelected ? "secondary" : "outline"}
                      className="mt-3 w-full font-medium"
                      disabled={!draftEnabled}
                      onClick={() => applyTheme("master")}
                    >
                      Use master summary
                    </Button>
                  </div>
                );
              })()}

              {/* Angles cards */}
              {plan.positioning.angles.map((angle) => {
                const isAngleSelected = summaryOrigin === angle.angleId && !summaryEdited;
                const quotes =
                  planData !== null && planData.version === 2
                    ? quotesForLinks(
                        (angle as PreparationPlanV2Type["positioning"]["angles"][number])
                          .priorityIds,
                      )
                    : [];
                return (
                  <div
                    key={angle.angleId}
                    className={cn(
                      "rounded-lg border p-3.5 text-xs flex flex-col justify-between transition-all",
                      isAngleSelected
                        ? "border-primary/60 bg-primary/5 ring-1 ring-primary/20 shadow-xs"
                        : "border-border/60 bg-background/50 hover:border-border/80",
                    )}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-foreground text-sm">{angle.title}</span>
                        {isAngleSelected && (
                          <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary text-[11px]">
                            Current
                          </Badge>
                        )}
                      </div>
                      <p className="mt-2 text-muted-foreground leading-relaxed">{angle.summaryText}</p>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        Supported by {angle.factIds.length} fact{angle.factIds.length === 1 ? "" : "s"}.
                      </p>
                      {quotes.length > 0 && (
                        <p className="mt-1.5 text-xs text-muted-foreground bg-muted/40 border border-border/40 rounded px-2 py-1">
                          Addresses: {quotes.map((quote) => `“${quote}”`).join(" · ")}
                        </p>
                      )}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant={isAngleSelected ? "secondary" : "outline"}
                      className="mt-3 w-full font-medium"
                      disabled={!draftEnabled}
                      onClick={() => applyTheme(angle.angleId === "angle-2" ? "angle-2" : "angle-1")}
                    >
                      Use this angle
                    </Button>
                  </div>
                );
              })}
            </div>

            {isV2Plan && (
              <p className="text-xs text-muted-foreground">
                The named origin keeps the summary&apos;s citations when you edit the text.
              </p>
            )}

            {themeConfirm !== null && (
              <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                <p className="font-medium">
                  Replace your unsaved summary edits with{" "}
                  {themeConfirm === "master"
                    ? "the master summary"
                    : `“${plan.positioning.angles.find((entry) => entry.angleId === themeConfirm)?.title ?? themeConfirm}”`}
                  ?
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" onClick={confirmTheme}>
                    Replace my edits
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    autoFocus
                    onClick={() => setThemeConfirm(null)}
                  >
                    Keep editing
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-1.5 pt-2">
              <p className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <label htmlFor="step2-summary" className="font-medium text-foreground">
                  {isV2Plan
                    ? `Summary (${originLabel}${summaryEdited ? " · edited" : ""})`
                    : `Summary (${currentSource === "edited" ? "edited" : `matches ${currentSource}`})`}
                </label>
                {segmentBadge(["summary"])}
              </p>
              <textarea
                id="step2-summary"
                className="min-h-24 w-full rounded-md border border-input bg-background p-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                rows={4}
                maxLength={SUMMARY_MAX_CHARS}
                disabled={!draftEnabled}
                placeholder="Choose a starting point above, or write a summary."
                value={summaryText}
                onChange={(event) => setSummaryText(event.target.value)}
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <p>
                  {[...summaryText].length} / {SUMMARY_MAX_CHARS} characters.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 3. Experience bullets */}
      <div className="rounded-lg border border-border/60 bg-card p-5 shadow-sm space-y-4">
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold tracking-tight text-foreground">Experience bullets</h3>
          <p className="text-xs text-muted-foreground">
            Master resume bullets organized by employment. Reorder, exclude, edit, or replace bullets with suggestions.
          </p>
        </div>
        {profileState !== "ready" || payload === null ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Master bullets appear with the captured profile.
          </p>
        ) : (
          <div className="mt-3 space-y-4">
            {!draftEnabled && (
              <p className="text-xs text-muted-foreground">
                Actions unlock once the accepted plan loads. Master content is never edited in place.
              </p>
            )}
            {dndError !== null && (
              <p role="status" className="text-xs font-medium text-destructive">
                {dndError}
              </p>
            )}
            {roleGroups.map((group) => {
              const label = employmentLabel(payload, group.roleId);
              const eligible = label !== null && group.roleId !== "";
              const groupName = label === null
                ? group.roleId === ""
                  ? "Unlinked experience"
                  : `Unknown role ${group.roleId}`
                : `${label.company} — ${label.role}`;
              return (
                <div
                  key={group.roleId === "" ? "(unlinked)" : group.roleId}
                  className={cn(
                    "rounded-lg border p-3.5 space-y-3 transition-colors",
                    dragOverRole === group.roleId ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border/60 bg-background/50",
                  )}
                  onDragOver={
                    eligible
                      ? (event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "copy";
                        }
                      : undefined
                  }
                  onDragEnter={() => {
                    if (eligible) {
                      setDragOverRole(group.roleId);
                    } else {
                      setDndError(`${groupName} cannot take suggestions — drop onto a role.`);
                    }
                  }}
                  onDragLeave={() => {
                    setDragOverRole((current) => (current === group.roleId ? null : current));
                  }}
                  onDrop={(event) => {
                    if (!eligible) {
                      return;
                    }
                    event.preventDefault();
                    setDragOverRole(null);
                    setDndError(null);
                    const data = event.dataTransfer.getData("text/plain");
                    if (data.startsWith("suggestion:")) {
                      const suggestionId = data.slice("suggestion:".length);
                      if (
                        planData !== null &&
                        planData.version === 2 &&
                        !rolesForSuggestion(suggestionId).some(
                          (entry) => entry.id === group.roleId,
                        )
                      ) {
                        setDndError(
                          `${groupName} is not eligible for this suggestion — drop it onto an eligible role.`,
                        );
                        return;
                      }
                      addSuggestion(suggestionId, group.roleId);
                    } else if (data.startsWith("instance:")) {
                      moveOperationToRole(data.slice("instance:".length), group.roleId);
                    }
                  }}
                >
                  <h4 className="text-sm font-semibold tracking-tight text-foreground">{groupName}</h4>
                  <ul className="space-y-2">
                    {group.rows.map((row) => (
                      <BulletRowView
                        key={row.key}
                        row={row}
                        operations={operations}
                        opErrorIndex={opErrorIndex}
                        draftEnabled={draftEnabled}
                        editBuffer={editBuffer}
                        isV2Plan={isV2Plan}
                        moveRoles={rolesForRow(row)}
                        segmentBadge={segmentBadge}
                        onEdit={(key, text) => setEditBuffer({ key, text })}
                        onSaveEdit={saveEditBuffer}
                        onCancelEdit={() => setEditBuffer(null)}
                        onEditText={(text) =>
                          setEditBuffer((current) => (current === null ? null : { ...current, text }))
                        }
                        onExclude={() => {
                          if (row.factId !== null) {
                            excludeBullet(row.factId);
                          }
                        }}
                        onUndo={() => {
                          const id = row.excludeOperationId ?? row.editOperationId ?? row.operationId;
                          if (id !== null) {
                            removeOperation(id);
                          }
                        }}
                        onMoveUp={() => {
                          if (row.operationId !== null) {
                            moveInstance(group.roleId, row.operationId, -1);
                          }
                        }}
                        onMoveDown={() => {
                          if (row.operationId !== null) {
                            moveInstance(group.roleId, row.operationId, 1);
                          }
                        }}
                        onMoveToRole={(roleId) => {
                          if (row.operationId !== null) {
                            moveOperationToRole(row.operationId, roleId);
                          }
                        }}
                      />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 4. Suggested bullets */}
      <div className="rounded-lg border border-border/60 bg-card p-5 shadow-sm space-y-4">
        <div className="space-y-0.5">
          <h3 className="text-base font-semibold tracking-tight text-foreground">Suggested bullets</h3>
          <p className="text-xs text-muted-foreground">
            Targeted bullet proposals tailored to this role and grounded in your master experience.
          </p>
        </div>
        {planState !== "ready" || plan === null ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Suggestions appear with the accepted plan.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {usableSuggestions.length === 0 && unusableSuggestions.length === 0 && (
              <p className="text-xs text-muted-foreground">The plan carries no suggestions.</p>
            )}
            <ul className="space-y-3">
              {usableSuggestions.map((suggestion) => {
                const added = addedBySuggestion.get(suggestion.suggestionId);
                const addedToDefaultRole = added !== undefined && added.op === "add" && added.roleId === suggestion.roleId;
                const editing = editBuffer?.key === `suggestion:${suggestion.suggestionId}`;
                const replaceTargets = master.filter((bullet) =>
                  rolesForSuggestion(suggestion.suggestionId).some(
                    (entry) => entry.id === bullet.roleId,
                  ),
                );
                const quotes =
                  planData !== null && planData.version === 2
                    ? quotesForLinks(
                        (suggestion as PreparationPlanV2Type["suggestions"][number])
                          .priorityIds,
                      )
                    : [];
                return (
                  <li
                    key={suggestion.suggestionId}
                    className="rounded-lg border border-border/60 bg-background/50 p-3.5 text-xs shadow-xs hover:border-border/80 transition-all space-y-2.5"
                    draggable={draftEnabled}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", `suggestion:${suggestion.suggestionId}`);
                      event.dataTransfer.effectAllowed = "copy";
                    }}
                    onDragEnd={() => {
                      setDragOverRole(null);
                    }}
                  >
                    <p className="flex items-start gap-1.5">
                      <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60 hover:text-muted-foreground cursor-grab" aria-hidden="true" />
                      <span className="flex-1 font-medium text-foreground leading-relaxed">{suggestion.text}</span>
                    </p>
                    <p className="text-muted-foreground">
                      {suggestion.suggestionId} · for {employmentName(suggestion.roleId)}
                    </p>
                    {quotes.length > 0 && (
                      <p className="text-muted-foreground bg-muted/40 border border-border/40 rounded px-2 py-1 inline-block">
                        Addresses: {quotes.map((quote) => `“${quote}”`).join(" · ")}
                      </p>
                    )}
                    <details className="group rounded-md border border-border/40 bg-muted/20 p-2 text-xs">
                      <summary className="cursor-pointer font-medium text-primary hover:underline select-none">
                        Evidence ({suggestion.factIds.length})
                      </summary>
                      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted-foreground">
                        {suggestion.factIds.map((factId) => {
                          const achievement = payload?.achievements.find(
                            (entry) => entry.factId === factId,
                          );
                          return (
                            <li key={factId}>
                              <span className="font-mono text-[11px] bg-muted/60 px-1 py-0.5 rounded border border-border/40">{factId}</span>
                              {achievement !== undefined && <span>: {achievement.text}</span>}
                            </li>
                          );
                        })}
                      </ul>
                      {isV2Plan && (
                        <p className="mt-1.5 text-muted-foreground">
                          Context from the captured resume — not a verification claim.
                        </p>
                      )}
                    </details>
                    {editing && editBuffer !== null ? (
                      <div className="mt-2 space-y-2">
                        <label
                          htmlFor={`edit-${suggestion.suggestionId}`}
                          className="font-medium"
                        >
                          Edit suggestion text
                        </label>
                        <textarea
                          id={`edit-${suggestion.suggestionId}`}
                          className="min-h-16 w-full rounded-md border border-input bg-background p-2.5 text-sm"
                          rows={3}
                          maxLength={2000}
                          autoFocus
                          value={editBuffer.text}
                          onChange={(event) =>
                            setEditBuffer({ key: editBuffer.key, text: event.target.value })
                          }
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" size="sm" onClick={saveEditBuffer}>
                            {added === undefined ? "Add edited text" : "Save edit"}
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setEditBuffer(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 flex flex-wrap items-center gap-2 pt-1 border-t border-border/40">
                        {addedToDefaultRole ? (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/30 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-400 inline-flex items-center"
                          >
                            <Check className="mr-1 h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                            <span>Added</span>
                          </Badge>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            className="font-medium"
                            disabled={!draftEnabled}
                            onClick={() => addSuggestion(suggestion.suggestionId, suggestion.roleId)}
                          >
                            Use
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!draftEnabled}
                          onClick={() =>
                            setEditBuffer({
                              key: `suggestion:${suggestion.suggestionId}`,
                              text: suggestion.text,
                            })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!draftEnabled || master.length === 0}
                          onClick={() =>
                            setReplaceFor((current) =>
                              current === suggestion.suggestionId ? null : suggestion.suggestionId,
                            )
                          }
                        >
                          Replace…
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setSkipped((current) => new Set(current).add(suggestion.suggestionId))
                          }
                        >
                          Skip
                        </Button>
                        <RoleChooser
                          controlId={`add-role-${suggestion.suggestionId}`}
                          label="Add to role"
                          buttonText="Add"
                          roles={rolesForSuggestion(suggestion.suggestionId).map((entry) => ({
                            id: entry.id,
                            label: `${entry.company} — ${entry.role}`,
                          }))}
                          defaultRoleId={suggestion.roleId}
                          disabled={!draftEnabled}
                          onChoose={(roleId) => addSuggestion(suggestion.suggestionId, roleId)}
                        />
                      </div>
                    )}
                    {replaceFor === suggestion.suggestionId && (
                      <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-muted/20 p-3">
                        <p className="font-medium text-foreground">
                          Replace one existing bullet with this suggestion (lands in{" "}
                          {employmentName(suggestion.roleId)}):
                        </p>
                        {replaceTargets.length === 0 && (
                          <p className="text-muted-foreground">
                            No eligible role can take this suggestion — the server enforces
                            the same rule.
                          </p>
                        )}
                        <ul className="space-y-1.5">
                          {replaceTargets.map((bullet) => (
                            <li
                              key={bullet.factId}
                              className="flex items-start justify-between gap-2 rounded border border-border/40 bg-background/80 p-2"
                            >
                              <span className="flex-1 text-muted-foreground leading-relaxed">
                                {bullet.text}{" "}
                                <span className="font-mono text-[11px] bg-muted/60 px-1 py-0.5 rounded border border-border/40">({bullet.factId})</span>
                              </span>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={!draftEnabled}
                                onClick={() =>
                                  replaceWithSuggestion(
                                    suggestion.suggestionId,
                                    bullet.factId,
                                    suggestion.roleId,
                                  )
                                }
                              >
                                Replace this bullet
                              </Button>
                            </li>
                          ))}
                        </ul>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setReplaceFor(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {skippedSuggestions.length > 0 && (
              <details className="mt-3 rounded-lg border border-border/50 bg-muted/10 p-3">
                <summary className="cursor-pointer text-xs font-semibold text-primary hover:underline select-none">
                  Skipped ({skippedSuggestions.length})
                </summary>
                <ul className="mt-2.5 space-y-2">
                  {skippedSuggestions.map((suggestion) => (
                    <li
                      key={suggestion.suggestionId}
                      className="flex items-start justify-between gap-2 rounded-lg border border-border/40 bg-background/50 p-2.5 text-xs text-muted-foreground"
                    >
                      <span className="flex-1">{suggestion.text}</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setSkipped((current) => {
                            const next = new Set(current);
                            next.delete(suggestion.suggestionId);
                            return next;
                          })
                        }
                      >
                        Unskip
                      </Button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {unusableSuggestions.length > 0 && (
              <div className="mt-3 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                <h4 className="text-xs font-semibold text-amber-800 dark:text-amber-300">Not usable</h4>
                <ul className="space-y-2">
                  {unusableSuggestions.map((suggestion) => (
                    <li
                      key={suggestion.suggestionId}
                      className="rounded-md border border-border/40 bg-background/60 p-2 text-xs text-muted-foreground"
                    >
                      <p>{suggestion.text}</p>
                      <p className="mt-1">
                        <Badge variant="outline">
                          {suggestion.unusableReason === "NO_EVIDENCE"
                            ? "Needs evidence"
                            : suggestion.unusableReason === "NEW_METRIC"
                              ? "Adds an unverified number"
                              : suggestion.unusableReason === "EMPLOYER_SWAP"
                                ? "Names another employer"
                                : suggestion.unusableReason === "PRIORITY_LINK_MISSING"
                                  ? "No linked JD priority"
                                  : suggestion.unusableReason === "INVALID_ANCHOR"
                                    ? "No usable evidence anchor"
                                    : suggestion.unusableReason === "UNKNOWN_ROLE"
                                      ? "Unknown role"
                                      : suggestion.unusableReason === "PROVIDER_ROLE_INELIGIBLE"
                                        ? "Role not eligible for its evidence"
                                        : (suggestion.unusableReason ?? "Not usable")}
                        </Badge>
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 5. Support and budgets */}
      <div className="rounded-lg border border-border/60 bg-card p-5 shadow-sm space-y-3">
        <h3 className="text-sm font-semibold text-foreground">Support and budgets</h3>
        {lengthGuidance.show && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
          >
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <div className="space-y-1 text-amber-900 dark:text-amber-200">
              <p>
                <span className="font-semibold">Resume length:</span> This draft
                has {lengthGuidance.totalBullets} bullets and may produce a
                resume longer than two pages. You can generate it as is, or
                remove a few bullets for a more concise resume.
              </p>
              {lengthGuidance.denseRoles.map((line) => (
                <p key={line.key}>
                  {line.label} has {line.used} bullets. Consider keeping the{" "}
                  {line.limit}–{line.limit + 1} most relevant to this job.
                </p>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-1.5 text-xs">
          {budgets.lines.map((line) => (
            <p key={line.key} className={cn("py-0.5", line.exceeded ? "font-medium text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
              {line.label}: {line.used} / {line.limit}
              {line.exceeded && (
                <span>
                  {" "}
                  — above the {line.limit} guideline.
                </span>
              )}
            </p>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 pt-2 border-t border-border/40">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!draftEnabled || checking}
            onClick={() => void checkNow(buffersRef.current)}
          >
            {checking ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            )}
            Check support
          </Button>
          {verdicts !== null && (
            <span className="text-xs text-muted-foreground">
              {verdictsCurrent
                ? `Checked ${verdicts.segments.length} segment${verdicts.segments.length === 1 ? "" : "s"} against this exact text.`
                : "Edits since the last check — badges show Checking…."}
            </span>
          )}
        </div>
      </div>

      {/* 6. Ordered operations */}
      <details className="rounded-lg border border-border/60 bg-card p-4 shadow-sm">
        <summary className="cursor-pointer text-sm font-semibold text-foreground hover:underline select-none">
          Draft operations ({operations.length})
        </summary>
        {operations.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            No operations yet. Used suggestions, replacements, exclusions, and edits list here
            in order, each reversible.
          </p>
        ) : (
          <ol className="mt-2.5 list-decimal space-y-1.5 pl-5 text-xs">
            {operations.map((op, index) => (
              <li
                key={op.operationId}
                className={index === opErrorIndex ? "font-medium text-destructive" : "text-muted-foreground"}
              >
                <span className="mr-2 text-foreground">{opSummary(op, employmentName)}</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => removeOperation(op.operationId)}>
                  <Undo2 className="mr-1 h-3 w-3" aria-hidden="true" />
                  Undo
                </Button>
                {index === opErrorIndex && <span className="text-destructive font-medium"> — the server rejected this item.</span>}
              </li>
            ))}
          </ol>
        )}
      </details>

      {/* Footer / Action bar */}
      {(generateError !== null || pendingGen !== null) && (
        <div
          className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-xs"
          role="alert"
        >
          <p className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {generateError ?? "An earlier submission may not have reached the server."}
          </p>
          {pendingGen !== null && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => void replayPendingGeneration()}
                disabled={generateState === "working"}
              >
                <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" />
                Replay same submission
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={discardPendingGeneration}>
                Discard
              </Button>
              <p className="w-full text-muted-foreground">
                Replay resends the exact saved bytes (operation {pendingGen.requestId}); it can
                never fork a second run.
              </p>
            </div>
          )}
        </div>
      )}
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/80 bg-background/95 p-4 shadow-lg backdrop-blur-sm">
        <Button type="button" variant="outline" onClick={() => onNavigateStep(1)}>
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Back
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          {generateDisabledReason !== null && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              <Info className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{generateDisabledReason}</span>
            </span>
          )}
          <Button
            type="button"
            disabled={generateDisabledReason !== null || generateState === "working"}
            title={generateDisabledReason ?? "Submit this edited plan for generation."}
            onClick={() => void submitGeneration()}
            className="min-w-[150px] font-medium"
          >
            {generateState === "working" && (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            )}
            Generate resume
            <ArrowRight className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Generate submits this exact edited plan; the resume still needs your review and approval.
        Nothing here approves a resume.
      </p>

      {/* Captured preview */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Captured profile{profileData !== null && ` — ${profileData.profile.displayName} v${profileData.version.version}`}
            </DialogTitle>
            <DialogDescription>
              The exact version this job captured. Later Settings edits never change it.
            </DialogDescription>
          </DialogHeader>
          {profileData !== null && (
            <MasterPreview payload={profileData.payload as unknown as PreviewPayload} />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

interface RoleChooserProps {
  controlId: string;
  label: string;
  buttonText: string;
  roles: Array<{ id: string; label: string }>;
  defaultRoleId: string;
  disabled: boolean;
  onChoose: (roleId: string) => void;
}

/** Keyboard/button equivalent of drag-and-drop role targeting. */
function RoleChooser({
  controlId,
  label,
  buttonText,
  roles,
  defaultRoleId,
  disabled,
  onChoose,
}: RoleChooserProps) {
  const [roleId, setRoleId] = useState(defaultRoleId);
  if (roles.length === 0) {
    return null;
  }
  const effective = roles.some((role) => role.id === roleId) ? roleId : roles[0].id;
  return (
    <span className="inline-flex items-center gap-1">
      <label htmlFor={controlId} className="sr-only">
        {label}
      </label>
      <select
        id={controlId}
        className="rounded-md border border-input bg-background px-1 py-1 text-xs"
        value={effective}
        disabled={disabled}
        onChange={(event) => setRoleId(event.target.value)}
      >
        {roles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.label}
          </option>
        ))}
      </select>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChoose(effective)}>
        {buttonText}
      </Button>
    </span>
  );
}

interface BulletRowViewProps {
  row: AppliedBulletRow;
  operations: Step2DraftOperationV1Type[];
  opErrorIndex: number | null;
  draftEnabled: boolean;
  editBuffer: { key: string; text: string } | null;
  isV2Plan: boolean;
  moveRoles: Array<{ id: string; company: string; role: string }>;
  segmentBadge: (segmentIds: Array<string | null>) => ReactNode;
  onEdit: (key: string, text: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onEditText: (text: string) => void;
  onExclude: () => void;
  onUndo: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveToRole: (roleId: string) => void;
}

function BulletRowView({
  row,
  operations,
  opErrorIndex,
  draftEnabled,
  editBuffer,
  isV2Plan,
  moveRoles,
  segmentBadge,
  onEdit,
  onSaveEdit,
  onCancelEdit,
  onEditText,
  onExclude,
  onUndo,
  onMoveUp,
  onMoveDown,
  onMoveToRole,
}: BulletRowViewProps) {
  const instance = row.kind === "added" || row.kind === "replaced";
  // Instance edits key by operation id, never by suggestion id:
  // sharing the suggestion-card key opened both editors at once.
  const editKey =
    row.kind === "master" && row.factId !== null
      ? `bullet:${row.factId}`
      : instance && row.operationId !== null && row.suggestionId !== null
        ? `instance:${row.operationId}`
        : null;
  const editing = editKey !== null && editBuffer?.key === editKey;
  const flaggedOpId = row.excludeOperationId ?? row.editOperationId ?? row.operationId;
  const flaggedIndex =
    flaggedOpId === null ? -1 : operations.findIndex((op) => op.operationId === flaggedOpId);
  const flagged = opErrorIndex !== null && flaggedIndex === opErrorIndex;
  const peers = operations.filter(
    (op) => (op.op === "add" || op.op === "replace") && op.roleId === row.roleId,
  );
  const peerIndex = peers.findIndex((op) => op.operationId === row.operationId);

  return (
    <li
      className={cn(
        "rounded-lg border p-3 text-xs transition-all",
        flagged
          ? "border-destructive bg-destructive/5"
          : "border-border/60 bg-background/80 hover:border-border/80 shadow-xs",
      )}
      draggable={instance && draftEnabled}
      onDragStart={
        instance && row.operationId !== null
          ? (event) => {
              event.dataTransfer.setData("text/plain", `instance:${row.operationId}`);
              event.dataTransfer.effectAllowed = "move";
            }
          : undefined
      }
    >
      <p className="flex items-start gap-1.5">
        {instance && (
          <GripVertical className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60 hover:text-muted-foreground cursor-grab" aria-hidden="true" />
        )}
        <span className={cn("flex-1 leading-relaxed", row.excluded ? "text-muted-foreground line-through" : "text-foreground")}>
          {row.text}
        </span>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground">
        {row.kind === "master" && row.factId !== null && (
          <span className="font-mono text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded border border-border/40 text-[11px]">
            {row.factId}
          </span>
        )}
        {row.kind === "added" && row.suggestionId !== null && <span>Suggested · {row.suggestionId}</span>}
        {row.kind === "replaced" && <span>Replaces {row.factId}</span>}
        {row.excluded && <Badge variant="outline" className="border-muted-foreground/30 text-muted-foreground">Excluded</Badge>}
        {!row.excluded && row.edited && (
          <Badge
            variant="outline"
            className="border-sky-500/30 bg-sky-500/10 font-medium text-sky-700 dark:text-sky-400 inline-flex items-center"
          >
            <Edit2 className="mr-1 inline h-3 w-3 text-sky-600 dark:text-sky-400" aria-hidden="true" />
            <span>Edited</span>
          </Badge>
        )}
        {!row.excluded && !row.edited && row.kind === "master" && isV2Plan && (
          <Badge
            variant="outline"
            className="border-emerald-500/30 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-400 inline-flex items-center"
            title="Exact master-resume text from the captured profile"
          >
            <ShieldCheck className="mr-1 inline h-3 w-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <span>Verified source</span>
          </Badge>
        )}
        {row.orphan && <Badge variant="destructive">Unknown suggestion</Badge>}
        {!row.excluded && row.kind === "master" && row.editOperationId !== null && (
          <span>{segmentBadge([`op:${row.editOperationId}`])}</span>
        )}
        {!row.excluded && instance && (
          <span>
            {segmentBadge([
              row.editOperationId === null ? null : `op:${row.editOperationId}`,
              row.operationId === null ? null : `op:${row.operationId}`,
            ])}
          </span>
        )}
      </div>
      {flagged && (
        <p className="mt-1 text-destructive">The server rejected this item — fix or undo it.</p>
      )}
      {row.orphan && (
        <p className="mt-1 text-muted-foreground">
          This suggestion is not in the bound plan; saving will report it, never drop it silently.
        </p>
      )}
      {editing && editBuffer !== null ? (
        <div className="mt-2 space-y-2">
          <label htmlFor={`edit-${row.key}`} className="font-medium">
            {row.kind === "master" ? "Reword bullet" : "Edit instance text"}
          </label>
          <textarea
            id={`edit-${row.key}`}
            className="min-h-16 w-full rounded-md border border-input bg-background p-2 text-sm"
            rows={3}
            maxLength={2000}
            autoFocus
            value={editBuffer.text}
            onChange={(event) => onEditText(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={onSaveEdit}>
              Save edit
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onCancelEdit}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {row.excluded ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!draftEnabled}
              onClick={onUndo}
              aria-label={`Undo exclusion of ${row.text.slice(0, 60)}`}
            >
              <Undo2 className="mr-1 h-3 w-3" aria-hidden="true" />
              Undo
            </Button>
          ) : (
            <>
              {row.kind === "master" && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!draftEnabled || editKey === null}
                    onClick={() => {
                      if (editKey !== null) {
                        onEdit(editKey, row.text);
                      }
                    }}
                  >
                    <Edit2 className="mr-1 h-3 w-3" aria-hidden="true" />
                    Edit
                  </Button>
                  {row.editOperationId !== null ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!draftEnabled}
                      onClick={onUndo}
                      aria-label={`Undo edit of ${row.text.slice(0, 60)}`}
                    >
                      <Undo2 className="mr-1 h-3 w-3" aria-hidden="true" />
                      Undo edit
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!draftEnabled}
                      onClick={onExclude}
                      aria-label={`Exclude ${row.text.slice(0, 60)}`}
                    >
                      <X className="mr-1 h-3 w-3" aria-hidden="true" />
                      Exclude
                    </Button>
                  )}
                </>
              )}
              {instance && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!draftEnabled || editKey === null}
                    onClick={() => {
                      if (editKey !== null) {
                        onEdit(editKey, row.text);
                      }
                    }}
                    aria-label={`Edit ${row.text.slice(0, 60)}`}
                  >
                    <Edit2 className="mr-1 h-3 w-3" aria-hidden="true" />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!draftEnabled}
                    onClick={onUndo}
                    aria-label={`Remove ${row.text.slice(0, 60)}`}
                  >
                    <Undo2 className="mr-1 h-3 w-3" aria-hidden="true" />
                    Undo
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!draftEnabled || peerIndex <= 0}
                    onClick={onMoveUp}
                    aria-label="Move up within role"
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!draftEnabled || peerIndex < 0 || peerIndex >= peers.length - 1}
                    onClick={onMoveDown}
                    aria-label="Move down within role"
                  >
                    ↓
                  </Button>
                  <RoleChooser
                    controlId={`move-role-${row.key}`}
                    label="Move to role"
                    buttonText="Move"
                    roles={moveRoles.map((entry) => ({
                      id: entry.id,
                      label: `${entry.company} — ${entry.role}`,
                    }))}
                    defaultRoleId={row.roleId}
                    disabled={!draftEnabled}
                    onChoose={onMoveToRole}
                  />
                </>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
