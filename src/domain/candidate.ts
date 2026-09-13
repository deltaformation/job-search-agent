import { z } from "zod";
import { Verification } from "./enums";
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
    payload: CandidateProfilePayloadV1,
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
    sponsorshipRequired: z.boolean().default(false),
    willingToRelocate: z.boolean().default(false),
    yearsOfExperience: z.number().finite().min(0).max(80).optional(),
    salaryExpectation: z
      .object({
        min: z.number().finite().min(0).optional(),
        target: z.number().finite().min(0).optional(),
        currency: TrimmedText(8).optional(),
      })
      .strict()
      .optional(),
    targetTitles: z.array(TrimmedText(200)).max(30).default([]),
    targetLocations: z.array(TrimmedText(200)).max(30).default([]),
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
