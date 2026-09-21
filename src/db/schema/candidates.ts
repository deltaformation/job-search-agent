import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt } from "./columns";

/**
 * Candidate profile root, reviewed versions, verified facts, and immutable
 * generation snapshots.
 *
 * R-ADR-012: the profile table holds one row per named career profile with
 * user-managed metadata; a partial unique index keeps at most one default
 * row and a guard trigger freezes identity columns (`id`, `name`,
 * `created_at`) while allowing metadata updates. Versions carry an
 * immutable typed payload; only `activated_at` may change after insert, and a
 * partial unique index plus a guard trigger keep exactly one version active
 * per profile. Facts become immutable once approved. Snapshot membership is
 * relational (`candidate_snapshot_facts`) so resume claims can be
 * foreign-keyed to the exact bound snapshot.
 */
export const candidateProfiles = sqliteTable(
  "candidate_profiles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique("candidate_profiles_name_unique"),
    displayName: text("display_name").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    workPreferencesJson: text("work_preferences_json"),
    executiveNarrative: text("executive_narrative"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("candidate_profiles_is_default", sql`${t.isDefault} IN (0, 1)`),
  ],
);

export const candidateProfileVersions = sqliteTable(
  "candidate_profile_versions",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => candidateProfiles.id),
    version: integer("version").notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadHash: text("payload_hash").notNull(),
    schemaVersion: text("schema_version").notNull(),
    activatedAt: text("activated_at"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("candidate_profile_versions_profile_version").on(
      t.profileId,
      t.version,
    ),
    uniqueIndex("v13_profile_version_owner").on(t.id, t.profileId),
    index("candidate_profile_versions_profile_id").on(t.profileId),
    check(
      "candidate_profile_versions_version",
      sql`${t.version} >= 1`,
    ),
  ],
);

export const candidateFacts = sqliteTable(
  "candidate_facts",
  {
    factId: text("fact_id").primaryKey(),
    profileVersionId: text("profile_version_id")
      .notNull()
      .references(() => candidateProfileVersions.id),
    kind: text("kind").notNull(),
    statement: text("statement").notNull(),
    evidenceJson: text("evidence_json"),
    verification: text("verification").notNull().default("PENDING"),
    source: text("source"),
    provenanceJson: text("provenance_json"),
    createdAt: createdAt(),
  },
  (t) => [
    index("candidate_facts_profile_version_id").on(t.profileVersionId),
    check(
      "candidate_facts_verification",
      sql`${t.verification} IN ('PENDING','APPROVED','REJECTED')`,
    ),
  ],
);

export const candidateSnapshots = sqliteTable(
  "candidate_snapshots",
  {
    id: text("id").primaryKey(),
    profileVersionId: text("profile_version_id")
      .notNull()
      .references(() => candidateProfileVersions.id),
    canonicalJson: text("canonical_json").notNull(),
    schemaVersion: text("schema_version").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("candidate_snapshots_version_hash").on(t.profileVersionId, t.sha256),
    index("candidate_snapshots_profile_version_id").on(t.profileVersionId),
    index("candidate_snapshots_sha256").on(t.sha256),
  ],
);

export const candidateSnapshotFacts = sqliteTable(
  "candidate_snapshot_facts",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => candidateSnapshots.id),
    factId: text("fact_id")
      .notNull()
      .references(() => candidateFacts.factId),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.factId] })],
);

/**
 * Profile/version-owned master source documents (R-ADR-016).
 *
 * One row per profile version: the validated master bytes that produced
 * it, stored immutably under the sources root. Rows are insert-only
 * (see migration `0006` triggers); bytes are content-verified on read
 * against the stored size/hash. `origin` names how the bytes entered;
 * `origin_detail_json` carries versioned detail (copy source,
 * reconstruction lineage).
 */
export const candidateSources = sqliteTable(
  "candidate_sources",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => candidateProfiles.id),
    profileVersionId: text("profile_version_id")
      .notNull()
      .references(() => candidateProfileVersions.id),
    relativePath: text("relative_path").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    origin: text("origin").notNull(),
    originDetailJson: text("origin_detail_json"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("candidate_sources_version_unique").on(t.profileVersionId),
    index("candidate_sources_profile_id").on(t.profileId),
    check(
      "candidate_sources_origin",
      sql`${t.origin} IN ('upload','paste','form','copy','cli','reconstructed','legacy')`,
    ),
    check("candidate_sources_byte_size", sql`${t.byteSize} >= 0`),
  ],
);

export type CandidateProfile = typeof candidateProfiles.$inferSelect;
export type CandidateProfileVersion =
  typeof candidateProfileVersions.$inferSelect;
export type CandidateFact = typeof candidateFacts.$inferSelect;
export type CandidateSource = typeof candidateSources.$inferSelect;
export type CandidateSnapshot = typeof candidateSnapshots.$inferSelect;
export type CandidateSnapshotFact = typeof candidateSnapshotFacts.$inferSelect;
