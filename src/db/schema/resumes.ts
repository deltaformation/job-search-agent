import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { jobAnalyses } from "./analysis";
import { candidateFacts } from "./candidates";
import { createdAt, updatedAt } from "./columns";
import { jobs } from "./jobs";

/**
 * Immutable resume versions with claim-level provenance and artifacts.
 *
 * Content and lineage columns can never change after insert; only
 * `review_state` transitions (until APPROVED, after which the row is frozen).
 * Every cited fact is a row in `resume_claim_facts`, guarded by a trigger that
 * requires membership in the exact bound candidate snapshot plus APPROVED
 * verification.
 */
export const resumeVersions = sqliteTable(
  "resume_versions",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    version: integer("version").notNull(),
    parentVersionId: text("parent_version_id").references(
      (): AnySQLiteColumn => resumeVersions.id,
    ),
    analysisId: text("analysis_id")
      .notNull()
      .references(() => jobAnalyses.id),
    templateId: text("template_id").notNull(),
    templateVersion: text("template_version").notNull(),
    templateHash: text("template_hash").notNull(),
    rankerVersion: text("ranker_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    configVersion: text("config_version").notNull(),
    renderSchemaVersion: text("render_schema_version").notNull(),
    contentJson: text("content_json").notNull(),
    contentHash: text("content_hash").notNull(),
    reviewState: text("review_state").notNull().default("DRAFT"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("resume_versions_job_version").on(t.jobId, t.version),
    index("resume_versions_job_id").on(t.jobId),
    index("resume_versions_analysis_id").on(t.analysisId),
    check("resume_versions_version", sql`${t.version} >= 1`),
    check(
      "resume_versions_review_state",
      sql`${t.reviewState} IN ('DRAFT','AWAITING_REVIEW','APPROVED','REVISION_REQUESTED','FAILED')`,
    ),
  ],
);

export const resumeClaims = sqliteTable(
  "resume_claims",
  {
    id: text("id").primaryKey(),
    resumeVersionId: text("resume_version_id")
      .notNull()
      .references(() => resumeVersions.id),
    claimText: text("claim_text").notNull(),
    requirementRef: text("requirement_ref"),
    derivationKind: text("derivation_kind"),
    derivationPayload: text("derivation_payload"),
    createdAt: createdAt(),
  },
  (t) => [index("resume_claims_version_id").on(t.resumeVersionId)],
);

export const resumeClaimFacts = sqliteTable(
  "resume_claim_facts",
  {
    claimId: text("claim_id")
      .notNull()
      .references(() => resumeClaims.id),
    factId: text("fact_id")
      .notNull()
      .references(() => candidateFacts.factId),
  },
  (t) => [primaryKey({ columns: [t.claimId, t.factId] })],
);

export const resumeArtifacts = sqliteTable(
  "resume_artifacts",
  {
    id: text("id").primaryKey(),
    resumeVersionId: text("resume_version_id")
      .notNull()
      .references(() => resumeVersions.id),
    kind: text("kind").notNull(),
    relativePath: text("relative_path").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("resume_artifacts_version_kind").on(t.resumeVersionId, t.kind),
    unique("resume_artifacts_version_sha").on(t.resumeVersionId, t.sha256),
    index("resume_artifacts_version_id").on(t.resumeVersionId),
    check(
      "resume_artifacts_kind",
      sql`${t.kind} IN ('MARKDOWN','DOCX','PDF')`,
    ),
    check("resume_artifacts_byte_size", sql`${t.byteSize} >= 0`),
  ],
);

export const resumeReviews = sqliteTable(
  "resume_reviews",
  {
    id: text("id").primaryKey(),
    resumeVersionId: text("resume_version_id")
      .notNull()
      .references(() => resumeVersions.id),
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    note: text("note"),
    resumeHash: text("resume_hash").notNull(),
    contentHash: text("content_hash").notNull(),
    artifactHashesJson: text("artifact_hashes_json").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("resume_reviews_version_id").on(t.resumeVersionId),
    check(
      "resume_reviews_action",
      sql`${t.action} IN ('APPROVED','REVISION_REQUESTED')`,
    ),
  ],
);

export type ResumeVersion = typeof resumeVersions.$inferSelect;
export type ResumeClaim = typeof resumeClaims.$inferSelect;
export type ResumeClaimFact = typeof resumeClaimFacts.$inferSelect;
export type ResumeArtifact = typeof resumeArtifacts.$inferSelect;
export type ResumeReview = typeof resumeReviews.$inferSelect;
