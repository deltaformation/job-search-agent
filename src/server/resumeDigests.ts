import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client";
import { resumeArtifacts } from "../db/schema/resumes";
import { canonicalJson } from "../domain/canonical";

/**
 * Lineage digests shared by review commands and v1.3 generation
 * submission (WO-1.3-E). Lives in its own module so both
 * `server/review.ts` and `server/generations.ts` can bind reviews to
 * stored bytes without a server-layer import cycle.
 */

export interface ResumeIdentityFields {
  id: string;
  jobId: string;
  version: number;
  parentVersionId: string | null;
  analysisId: string;
  templateId: string;
  templateVersion: string;
  templateHash: string;
  rankerVersion: string;
  policyVersion: string;
  configVersion: string;
  renderSchemaVersion: string;
  contentHash: string;
}

/**
 * Lineage-binding resume hash recorded on every review. `contentHash`
 * identifies the rendered bytes; `resumeHash` identifies the exact version
 * row those bytes came from — id, job, number, parent, analysis, and every
 * template/ranker/policy/config lineage field — so a review row alone
 * proves what was approved without trusting a bare version id.
 */
export function resumeIdentityHash(version: ResumeIdentityFields): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        schemaVersion: "resume-identity/v1",
        resumeVersionId: version.id,
        jobId: version.jobId,
        version: version.version,
        parentVersionId: version.parentVersionId,
        analysisId: version.analysisId,
        templateId: version.templateId,
        templateVersion: version.templateVersion,
        templateHash: version.templateHash,
        rankerVersion: version.rankerVersion,
        policyVersion: version.policyVersion,
        configVersion: version.configVersion,
        renderSchemaVersion: version.renderSchemaVersion,
        contentHash: version.contentHash,
      }),
      "utf8",
    )
    .digest("hex");
}

export interface ArtifactDigests {
  markdown: string;
  docx: string;
  pdf: string;
}

/**
 * Stored digests for revision reviews. A revision must be requestable even
 * when artifact bytes are damaged — damage is a reason to revise, not a
 * blocker — so this binds the recorded digests without touching disk.
 */
export function storedArtifactDigests(
  handle: DatabaseHandle,
  resumeVersionId: string,
): ArtifactDigests | null {
  const rows = handle.db
    .select()
    .from(resumeArtifacts)
    .where(eq(resumeArtifacts.resumeVersionId, resumeVersionId))
    .all();
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const markdown = byKind.get("MARKDOWN");
  const docx = byKind.get("DOCX");
  const pdf = byKind.get("PDF");
  if (markdown === undefined || docx === undefined || pdf === undefined) {
    return null;
  }
  return { markdown: markdown.sha256, docx: docx.sha256, pdf: pdf.sha256 };
}
