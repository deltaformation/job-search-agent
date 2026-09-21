import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, updatedAt } from "./columns";
import { candidateProfiles, candidateProfileVersions, candidateSources } from "./candidates";
import { generationRequests } from "./generation";
import { intakeBatches, intakeItems } from "./intake";
import { jobExtractions, jobs } from "./jobs";
import { workAttempts, workItems } from "./queue";

/**
 * Step 2 preparation tables (WO-1.3-S2-B, migration 0009). Exact
 * Drizzle mirror of `drizzle/0009_step2_preparation.sql`: one
 * preparation row per intake-bound job, append-only plan history
 * with a forward-only accepted pointer, fenced boundary events,
 * persisted draft verdicts, and the immutable edited-plan
 * generation-input extension (written by S2-D).
 */

export const step2Preparations = sqliteTable(
  "step2_preparations",
  {
    id: text("id").primaryKey(),
    intakeItemId: text("intake_item_id")
      .unique()
      .references(() => intakeItems.id),
    jobId: text("job_id")
      .unique()
      .references(() => jobs.id),
    batchId: text("batch_id").references(() => intakeBatches.id),
    profileId: text("profile_id")
      .notNull()
      .references(() => candidateProfiles.id),
    profileVersionId: text("profile_version_id")
      .notNull()
      .references(() => candidateProfileVersions.id),
    extractionId: text("extraction_id").references(() => jobExtractions.id),
    profilePayloadHash: text("profile_payload_hash").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    masterSourceId: text("master_source_id").references(() => candidateSources.id),
    bindingJson: text("binding_json").notNull(),
    state: text("state").notNull().default("PENDING"),
    workItemId: text("work_item_id")
      .unique()
      .references(() => workItems.id),
    acceptedPlanId: text("accepted_plan_id"),
    lastOperationId: text("last_operation_id"),
    lastOperationHash: text("last_operation_hash"),
    failureJson: text("failure_json"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("s2_preparations_job_id").on(t.jobId),
    index("s2_preparations_batch_id").on(t.batchId),
    index("s2_preparations_state").on(t.state),
    check(
      "s2_prep_state",
      sql`${t.state} IN ('PENDING','QUEUED','RUNNING','SUCCEEDED','FAILED')`,
    ),
  ],
);

export const step2Plans = sqliteTable(
  "step2_plans",
  {
    id: text("id").primaryKey(),
    preparationId: text("preparation_id")
      .notNull()
      .references(() => step2Preparations.id),
    planSeq: integer("plan_seq").notNull(),
    planJson: text("plan_json").notNull(),
    planHash: text("plan_hash").notNull(),
    providerId: text("provider_id").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    proposalSchemaVersion: text("proposal_schema_version").notNull(),
    claimsPolicyVersion: text("claims_policy_version").notNull(),
    inputHash: text("input_hash").notNull(),
    proposalHash: text("proposal_hash").notNull(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => workAttempts.id),
    validationJson: text("validation_json").notNull(),
    supersedesPlanId: text("supersedes_plan_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("s2_plans_preparation_id").on(t.preparationId),
    uniqueIndex("s2_plans_hash").on(t.preparationId, t.planHash),
  ],
);

export const step2PreparationEvents = sqliteTable(
  "step2_preparation_events",
  {
    attemptId: text("attempt_id").notNull(),
    seq: integer("seq").notNull(),
    preparationId: text("preparation_id")
      .notNull()
      .references(() => step2Preparations.id),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItems.id),
    stage: text("stage").notNull(),
    source: text("source").notNull(),
    leaseToken: text("lease_token").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.seq] }),
    index("s2_events_preparation_id").on(t.preparationId),
  ],
);

export const step2DraftValidations = sqliteTable(
  "step2_draft_validations",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    planId: text("plan_id")
      .notNull()
      .references(() => step2Plans.id),
    workspaceRevision: integer("workspace_revision").notNull(),
    draftHash: text("draft_hash").notNull(),
    verdictJson: text("verdict_json").notNull(),
    policyVersion: text("policy_version").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("s2_verdicts_job_hash").on(t.jobId, t.draftHash),
    index("s2_verdicts_plan_id").on(t.planId),
  ],
);

export const step2GenerationInputs = sqliteTable(
  "step2_generation_inputs",
  {
    requestId: text("request_id")
      .primaryKey()
      .references(() => generationRequests.id),
    planId: text("plan_id")
      .notNull()
      .references(() => step2Plans.id),
    planHash: text("plan_hash").notNull(),
    draftHash: text("draft_hash").notNull(),
    validationId: text("validation_id")
      .notNull()
      .references(() => step2DraftValidations.id),
    editedInputsJson: text("edited_inputs_json").notNull(),
    policyVersionsJson: text("policy_versions_json").notNull(),
    createdAt: createdAt(),
  },
  () => [],
);

export type Step2Preparation = typeof step2Preparations.$inferSelect;
export type Step2Plan = typeof step2Plans.$inferSelect;
export type Step2PreparationEvent = typeof step2PreparationEvents.$inferSelect;
export type Step2DraftValidation = typeof step2DraftValidations.$inferSelect;
export type Step2GenerationInput = typeof step2GenerationInputs.$inferSelect;
