import { z } from "zod";
import { SalaryPeriod, Verification } from "./enums";
import { EntityId } from "./fields";

/**
 * Versioned candidate-profile shapes. `CandidateImportV1` is the reviewed
 * master-resume JSON file a human authors at an ignored local path;
 * `CandidateProfilePayloadV1` is the immutable normalized payload stored on
 * each profile version; `CandidateSnapshotV1` is the self-contained
 * generation input bound to resume work.
 *
 * R-ADR-012 adds per-profile career metadata (`WorkPreferencesV1`,
 * `CareerProfileV1`): user-managed settings owned by each named profile,
 * stored as versioned JSON beside — never inside — immutable versions and
 * snapshots. The boundary stands: profile preferences never become resume
 * claims, and the app never auto-answers legal, authorization,
 * compensation, or self-identification questions, so the importer still
 * refuses to carry standard answers or application-session state.
 */

export const CANDIDATE_IMPORT_SCHEMA_VERSION = "candidate-import/v1";
export const CANDIDATE_PROFILE_SCHEMA_VERSION = "candidate-profile/v1";
export const CANDIDATE_SNAPSHOT_SCHEMA_VERSION = "candidate-snapshot/v1";
export const CANDIDATE_IMPORT_SCHEMA_VERSION_V2 = "candidate-import/v2";
export const CANDIDATE_PROFILE_SCHEMA_VERSION_V2 = "candidate-profile/v2";

const TrimmedText = (max: number) => z.string().trim().min(1).max(max);

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "expected YYYY-MM-DD" })
  .refine(
    (value) => {
      const [year, month, day] = value.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    },
    { message: "expected a real calendar date" },
  );

export const FactId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, {
    message: "fact_id must start alphanumerically and use [A-Za-z0-9_.-]",
  });
export type FactId = z.infer<typeof FactId>;

const EmploymentId = z.string().trim().min(1).max(64);

const IdentityV1 = z
  .object({
    fullName: TrimmedText(200),
    headline: TrimmedText(300).optional(),
    email: z.email().max(320).optional(),
    phone: TrimmedText(40).optional(),
    location: TrimmedText(200).optional(),
  })
  .strict();

/** Contact links are identity-adjacent display data, never claim facts. */
const IdentityLinksV2 = z
  .object({
    linkedin: TrimmedText(500).optional(),
    github: TrimmedText(500).optional(),
    portfolio: TrimmedText(500).optional(),
    website: TrimmedText(500).optional(),
  })
  .strict();

const IdentityV2 = IdentityV1.extend({ links: IdentityLinksV2.optional() }).strict();

const EmploymentV1 = z
  .object({
    id: EmploymentId,
    company: TrimmedText(200),
    role: TrimmedText(200),
    location: TrimmedText(200).optional(),
    startDate: IsoDate,
    endDate: IsoDate.optional(),
    isCurrent: z.boolean(),
    description: z.string().trim().max(2000).optional(),
  })
  .strict()
  .superRefine((employment, ctx) => {
    if (employment.isCurrent && employment.endDate !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "current employment must not set endDate",
        path: ["endDate"],
      });
    }
    if (!employment.isCurrent && employment.endDate === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "past employment requires endDate",
        path: ["endDate"],
      });
    }
    if (
      employment.endDate !== undefined &&
      employment.endDate < employment.startDate
    ) {
      ctx.addIssue({
        code: "custom",
        message: "endDate must not precede startDate",
        path: ["endDate"],
      });
    }
  });

const AchievementV1 = z
  .object({
    factId: FactId,
    employmentId: EmploymentId.optional(),
    category: TrimmedText(80),
    text: TrimmedText(2000),
    technologies: z.array(TrimmedText(120)).max(50).default([]),
    metrics: z.array(TrimmedText(200)).max(50).default([]),
    source: TrimmedText(200).optional(),
    verification: Verification.default("PENDING"),
  })
  .strict();

const SkillProficiency = z.enum(["beginner", "proficient", "expert"]);

/** Spoken/written languages: capability claims like skills. */
const LanguageV2 = z
  .object({
    name: TrimmedText(200),
    proficiency: SkillProficiency.optional(),
    verified: z.boolean(),
  })
  .strict();

const SkillV1 = z
  .object({
    name: TrimmedText(200),
    category: TrimmedText(80).optional(),
    proficiency: SkillProficiency.optional(),
    yearsExperience: z.number().finite().min(0).max(80).optional(),
    verified: z.boolean(),
  })
  .strict();

const EducationV1 = z
  .object({
    degree: TrimmedText(200),
    fieldOfStudy: TrimmedText(200).optional(),
    institution: TrimmedText(200),
    startDate: IsoDate.optional(),
    endDate: IsoDate.optional(),
  })
  .strict()
  .superRefine((education, ctx) => {
    if (
      education.startDate !== undefined &&
      education.endDate !== undefined &&
      education.endDate < education.startDate
    ) {
      ctx.addIssue({
        code: "custom",
        message: "endDate must not precede startDate",
        path: ["endDate"],
      });
    }
  });

const CredentialV1 = z
  .object({
    name: TrimmedText(200),
    issuer: TrimmedText(200).optional(),
    issuedDate: IsoDate.optional(),
    credentialId: TrimmedText(120).optional(),
  })
  .strict();

const ProfileBodyFields = {
  identity: IdentityV1,
  targetTitles: z.array(TrimmedText(200)).max(30).default([]),
  targetLocations: z.array(TrimmedText(200)).max(30).default([]),
  summary: z.string().trim().max(2000).optional(),
  employment: z.array(EmploymentV1).max(50).default([]),
  achievements: z.array(AchievementV1).max(500).default([]),
  skills: z.array(SkillV1).max(200).default([]),
  education: z.array(EducationV1).max(20).default([]),
  credentials: z.array(CredentialV1).max(50).default([]),
};

type ProfileBody = {
  employment: Array<{ id: string }>;
  achievements: Array<{ factId: string; employmentId?: string }>;
};

function checkProfileBody(body: ProfileBody, ctx: z.RefinementCtx): void {
  const employmentIds = new Set(body.employment.map((entry) => entry.id));
  if (employmentIds.size !== body.employment.length) {
    ctx.addIssue({ code: "custom", message: "employment ids must be unique" });
  }
  const factIds = body.achievements.map((entry) => entry.factId);
  if (new Set(factIds).size !== factIds.length) {
    ctx.addIssue({ code: "custom", message: "fact_id values must be unique" });
  }
  for (const achievement of body.achievements) {
    if (
      achievement.employmentId !== undefined &&
      !employmentIds.has(achievement.employmentId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: `achievement ${achievement.factId} references unknown employment '${achievement.employmentId}'`,
      });
    }
  }
}

export const CandidateImportV1 = z
  .object({ schemaVersion: z.literal(CANDIDATE_IMPORT_SCHEMA_VERSION), ...ProfileBodyFields })
  .strict()
  .superRefine(checkProfileBody);
export type CandidateImportV1 = z.infer<typeof CandidateImportV1>;

export const CandidateProfilePayloadV1 = z
  .object({ schemaVersion: z.literal(CANDIDATE_PROFILE_SCHEMA_VERSION), ...ProfileBodyFields })
  .strict()
  .superRefine(checkProfileBody);
export type CandidateProfilePayloadV1 = z.infer<typeof CandidateProfilePayloadV1>;

/**
 * v2 additions (WO-1.2-B): contact links and languages join the
 * versioned claim sources. Career keywords, profile notes, and the
 * work-preference inventory stay mutable planning data on the profile
 * row (`WorkPreferencesV1`), never versioned evidence. Import v2
 * achievements may carry `editedFrom` (a fact-edit annotation the
 * server validates and records as row provenance, then strips from
 * the stored payload, which stays pure content).
 */
const ImportAchievementV2 = z
  .object({
    factId: FactId,
    employmentId: EmploymentId.optional(),
    category: TrimmedText(80),
    text: TrimmedText(2000),
    technologies: z.array(TrimmedText(120)).max(50).default([]),
    metrics: z.array(TrimmedText(200)).max(50).default([]),
    source: TrimmedText(200).optional(),
    verification: Verification.default("PENDING"),
    editedFrom: FactId.optional(),
  })
  .strict();

const ProfileBodyFieldsV2 = {
  ...ProfileBodyFields,
  identity: IdentityV2,
  languages: z.array(LanguageV2).max(30).default([]),
};

export const CandidateImportV2 = z
  .object({
    schemaVersion: z.literal(CANDIDATE_IMPORT_SCHEMA_VERSION_V2),
    ...ProfileBodyFieldsV2,
    achievements: z.array(ImportAchievementV2).max(500).default([]),
  })
  .strict()
  .superRefine(checkProfileBody);
export type CandidateImportV2 = z.infer<typeof CandidateImportV2>;

export const CandidateProfilePayloadV2 = z
  .object({ schemaVersion: z.literal(CANDIDATE_PROFILE_SCHEMA_VERSION_V2), ...ProfileBodyFieldsV2 })
  .strict()
  .superRefine(checkProfileBody);
export type CandidateProfilePayloadV2 = z.infer<typeof CandidateProfilePayloadV2>;

/** Either stored payload generation; v1 rows keep working unchanged. */
export const StoredProfilePayload = z.union([CandidateProfilePayloadV1, CandidateProfilePayloadV2]);
export type StoredProfilePayload = z.infer<typeof StoredProfilePayload>;

/**
 * Parse one stored version payload by its stamped literal. Unknown
 * versions fail closed — never guessed.
 */
export function parseStoredProfilePayload(data: unknown): StoredProfilePayload {
  const version =
    typeof data === "object" && data !== null && "schemaVersion" in data
      ? (data as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (version === CANDIDATE_PROFILE_SCHEMA_VERSION) {
    return CandidateProfilePayloadV1.parse(data);
  }
  if (version === CANDIDATE_PROFILE_SCHEMA_VERSION_V2) {
    return CandidateProfilePayloadV2.parse(data);
  }
  throw new Error(`unsupported stored profile payload version: ${JSON.stringify(version)}`);
}

/**
 * Normalize an authored master document (import v1, import v2, payload
 * v1/v2, or an unstamped v1/v2 body — the upload path historically
 * ignores the incoming literal) to a v2 payload plus the per-achievement
 * edit annotations for provenance recording. v1 bodies are a strict
 * subset of v2, so one v2 parse accepts every previously valid document.
 */
export function normalizeImportDocument(document: unknown): {
  importVersion: 1 | 2 | "unstamped";
  payload: CandidateProfilePayloadV2;
  editedFrom: Map<string, string>;
} {
  const record = (document ?? {}) as Record<string, unknown>;
  const literal = record["schemaVersion"];
  const importVersion =
    literal === CANDIDATE_IMPORT_SCHEMA_VERSION || literal === CANDIDATE_PROFILE_SCHEMA_VERSION
      ? 1
      : literal === CANDIDATE_IMPORT_SCHEMA_VERSION_V2 ||
          literal === CANDIDATE_PROFILE_SCHEMA_VERSION_V2
        ? 2
        : "unstamped";
  const parsed = CandidateImportV2.parse({
    ...record,
    schemaVersion: CANDIDATE_IMPORT_SCHEMA_VERSION_V2,
  });
  const editedFrom = new Map<string, string>();
  for (const achievement of parsed.achievements) {
    if (achievement.editedFrom !== undefined) {
      editedFrom.set(achievement.factId, achievement.editedFrom);
    }
  }
  const payload = CandidateProfilePayloadV2.parse({
    ...parsed,
    schemaVersion: CANDIDATE_PROFILE_SCHEMA_VERSION_V2,
    achievements: parsed.achievements.map(({ editedFrom: _edited, ...rest }) => rest),
  });
  return { importVersion, payload, editedFrom };
}

/** Evidence co-stored with each fact row (`candidate_facts.evidence_json`). */
export const FactEvidenceV1 = z
  .object({
    schemaVersion: z.literal("fact-evidence/v1"),
    employmentId: EmploymentId.optional(),
    category: TrimmedText(80),
    technologies: z.array(z.string().min(1)).max(50),
    metrics: z.array(z.string().min(1)).max(50),
  })
  .strict();
export type FactEvidenceV1 = z.infer<typeof FactEvidenceV1>;

/** One approved fact embedded in a candidate snapshot. */
export const SnapshotFactV1 = z
  .object({
    factId: FactId,
    kind: TrimmedText(80),
    statement: TrimmedText(2000),
    evidence: FactEvidenceV1.nullable(),
    source: z.string().trim().min(1).max(200).nullable(),
    verification: z.literal("APPROVED"),
  })
  .strict();
export type SnapshotFactV1 = z.infer<typeof SnapshotFactV1>;

export const CandidateSnapshotV1 = z
  .object({
    schemaVersion: z.literal(CANDIDATE_SNAPSHOT_SCHEMA_VERSION),
    profileVersionId: EntityId,
    version: z.int().min(1),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    payload: StoredProfilePayload,
    facts: z.array(SnapshotFactV1).max(500),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const factIds = snapshot.facts.map((fact) => fact.factId);
    if (new Set(factIds).size !== factIds.length) {
      ctx.addIssue({ code: "custom", message: "snapshot fact_id values must be unique" });
    }
  });
export type CandidateSnapshotV1 = z.infer<typeof CandidateSnapshotV1>;

export const WORK_PREFERENCES_SCHEMA_VERSION = "work-preferences/v1";
export const CAREER_PROFILE_SCHEMA_VERSION = "career-profile/v1";

/** Unique slug identifier for a career profile (`staff-engineer`). */
/** Profile row id: UUIDs for created profiles, `"local"` for the legacy root. */
export const ProfileId = z.string().trim().min(1).max(64);
export type ProfileId = z.infer<typeof ProfileId>;

export const ProfileSlug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "profile name must be a lowercase slug ([a-z0-9-])",
  });
export type ProfileSlug = z.infer<typeof ProfileSlug>;

export const ProfileDisplayName = TrimmedText(200);
export type ProfileDisplayName = z.infer<typeof ProfileDisplayName>;

export const FACT_PROVENANCE_SCHEMA_VERSION = "fact-provenance/v1";

/**
 * Explicit reuse lineage for one fact row (R-ADR-020), stored in
 * `candidate_facts.provenance_json`. `copy`: B6 profile copy retaining
 * verification; `import-remap`: cross-profile import auto-mint;
 * `edit`: form/JSON revision of one approved claim. `evidenceHash` is
 * the canonical evidence fingerprint the reuse was judged identical by.
 */
export const FactProvenanceV1 = z
  .object({
    schemaVersion: z.literal(FACT_PROVENANCE_SCHEMA_VERSION),
    origin: z.enum(["copy", "import-remap", "edit"]),
    originProfileId: ProfileId.optional(),
    originVersionId: EntityId.optional(),
    originFactId: FactId,
    evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type FactProvenanceV1 = z.infer<typeof FactProvenanceV1>;

const WorkModeV1 = z.enum(["REMOTE", "HYBRID", "ONSITE"]);

/**
 * User-managed work preferences stored as JSON on a career profile row.
 * Steering metadata only: never a resume claim source and never an answer
 * to authorization, compensation, or self-identification questions.
 */
export const WorkPreferencesV1 = z
  .object({
    schemaVersion: z.literal(WORK_PREFERENCES_SCHEMA_VERSION),
    workAuthorization: z.array(TrimmedText(120)).max(20).default([]),
    workMode: z.array(WorkModeV1).max(3).default([]),
    // Tri-state since WO-1.2-B: null means unknown/unspecified and must
    // never be read as a claim. Old stored `false` still parses.
    sponsorshipRequired: z.boolean().nullable().default(null),
    willingToRelocate: z.boolean().nullable().default(null),
    yearsOfExperience: z.number().finite().min(0).max(80).optional(),
    salaryExpectation: z
      .object({
        min: z.number().finite().min(0).optional(),
        target: z.number().finite().min(0).optional(),
        currency: TrimmedText(8).optional(),
        period: SalaryPeriod.optional(),
      })
      .strict()
      .optional(),
    targetTitles: z.array(TrimmedText(200)).max(30).default([]),
    targetLocations: z.array(TrimmedText(200)).max(30).default([]),
    // Mutable steering vocabulary and planning notes (WO-1.2-B):
    // emphasis hints, never evidence. Versions stay untouched.
    careerKeywords: z.array(TrimmedText(120)).max(50).default([]),
    profileNotes: z.string().trim().max(2000).optional(),
  })
  .strict();
export type WorkPreferencesV1 = z.infer<typeof WorkPreferencesV1>;

/** Caller input: preferences without the stamped envelope version. */
export const WorkPreferencesInputV1 = WorkPreferencesV1.omit({ schemaVersion: true });
export type WorkPreferencesInputV1 = z.infer<typeof WorkPreferencesInputV1>;

/** One named career profile: identity row plus parsed preferences. */
export const CareerProfileV1 = z
  .object({
    schemaVersion: z.literal(CAREER_PROFILE_SCHEMA_VERSION),
    id: z.string().trim().min(1).max(64),
    name: ProfileSlug,
    displayName: ProfileDisplayName,
    isDefault: z.boolean(),
    workPreferences: WorkPreferencesV1.nullable(),
    executiveNarrative: z.string().trim().max(2000).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type CareerProfileV1 = z.infer<typeof CareerProfileV1>;

export const CreateCareerProfileInputV1 = z
  .object({
    name: ProfileSlug,
    displayName: ProfileDisplayName,
    workPreferences: WorkPreferencesInputV1.optional(),
    executiveNarrative: z.string().trim().max(2000).optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();
export type CreateCareerProfileInputV1 = z.infer<typeof CreateCareerProfileInputV1>;

export const UpdateCareerProfileInputV1 = z
  .object({
    displayName: ProfileDisplayName.optional(),
    workPreferences: WorkPreferencesInputV1.nullable().optional(),
    executiveNarrative: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
export type UpdateCareerProfileInputV1 = z.infer<typeof UpdateCareerProfileInputV1>;
