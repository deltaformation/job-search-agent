// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { generationRequests, jobs, workItems } from "../../../src/db";
import { getActiveProfileVersion, listFactsByVersion } from "../../../src/db/candidates";
import { getResumeReviewView, requestRevision } from "../../../src/server/review";
import { requestGeneration } from "../../../src/server/tailoring";
import { PM_GUIDANCE, runWithWorld, SPM_GUIDANCE } from "./world";

/**
 * WO-1.2-D acceptance for cross-profile new versions (R-ADR-017,
 * D2–D3). The world holds real imported + activated PM/SPM versions
 * with approved facts, a real parent v1 bound to the PM snapshot, and
 * guidance keywords present in the seeded JD — it satisfies v1.2
 * preflight, so the explicit generation command consumes it directly.
 */

describe("cross-profile new versions (R-ADR-017)", () => {
  it("guard: world satisfies v1.2 preflight prerequisites", () => {
    runWithWorld((t, world) => {
      const pmActive = getActiveProfileVersion(t.handle, world.pmProfileId);
      expect(pmActive?.id).toBe(world.pmVersionId);
      const pmApproved = listFactsByVersion(t.handle, world.pmVersionId).filter(
        (fact) => fact.verification === "APPROVED",
      );
      expect(pmApproved.length).toBeGreaterThan(0);
      const spmActive = getActiveProfileVersion(t.handle, world.spmProfileId);
      expect(spmActive?.id).toBe(world.spmVersionId);
      const spmApproved = listFactsByVersion(t.handle, world.spmVersionId).filter(
        (fact) => fact.verification === "APPROVED",
      );
      expect(spmApproved.length).toBeGreaterThan(0);
      for (const keyword of [...PM_GUIDANCE.selectedKeywords, ...SPM_GUIDANCE.selectedKeywords]) {
        expect(world.jdText.toLowerCase()).toContain(keyword.toLowerCase());
      }
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, world.jobId)).get();
      expect(job).toMatchObject({
        status: "NEW",
        tailoringState: "AWAITING_REVIEW",
        activeExtractionId: world.extractionId,
        activeResumeVersionId: world.v1Id,
      });
      expect(String(job?.descriptionText).trim().length).toBeGreaterThan(0);
      const view = getResumeReviewView(t.handle, world.v1Id);
      expect(view?.version.version).toBe(1);
      expect(view?.version.reviewState).toBe("AWAITING_REVIEW");
      expect(view?.claims.map((claim) => claim.claimText)).toContain(
        "Led customer discovery with 40+ B2B SaaS buyers.",
      );
      const v1Item = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, world.v1WorkItemId))
        .get();
      expect(v1Item?.state).toBe("SUCCEEDED");
    });
  });

  it("a Senior PM new-version request starts a run bound to that profile (D2–D3)", () => {
    runWithWorld((t, world) => {
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, world.jobId)).get();
      const result = requestGeneration(
        t.handle,
        {
          jobId: world.jobId,
          observedRowVersion: job?.rowVersion ?? 1,
          actor: "human",
          profileId: world.spmProfileId,
          selectedKeywords: [...SPM_GUIDANCE.selectedKeywords],
          directives: SPM_GUIDANCE.directives,
          parentVersionId: world.v1Id,
        },
        { providerAvailable: () => true },
      );
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) {
        return;
      }
      expect(result.requestKind).toBe("NEW_VERSION");
      const item = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, result.workItemId))
        .get();
      const payload = JSON.parse(String(item?.payloadJson)) as Record<string, unknown>;
      expect(payload["schemaVersion"]).toBe("tailor-queue/v2");
      expect(payload["generationRequestId"]).toBe(result.requestId);
      expect(payload["extractionId"]).toBe(world.extractionId);
      expect(payload["profileId"]).toBe(world.spmProfileId);
      expect(payload["profileVersionId"]).toBe(world.spmVersionId);
      expect(payload["parentVersionId"]).toBe(world.v1Id);
      const request = t.handle.db
        .select()
        .from(generationRequests)
        .where(eq(generationRequests.id, result.requestId))
        .get();
      expect(request).toMatchObject({
        requestKind: "NEW_VERSION",
        profileId: world.spmProfileId,
        profileVersionId: world.spmVersionId,
        parentVersionId: world.v1Id,
        directivesText: SPM_GUIDANCE.directives,
      });
      expect(JSON.parse(String(request?.selectedKeywordsJson))).toEqual(
        [...SPM_GUIDANCE.selectedKeywords].sort(),
      );
    });
  });

  it("a revision follow-up binds its real parent version (D3)", () => {
    runWithWorld((t, world) => {
      const job = t.handle.db.select().from(jobs).where(eq(jobs.id, world.jobId)).get();
      const revised = requestRevision(
        t.handle,
        {
          jobId: world.jobId,
          resumeVersionId: world.v1Id,
          observedRowVersion: job?.rowVersion ?? 1,
          actor: "human",
          note: "The summary buries the B2B SaaS discovery wins; lead with them.",
        },
        { providerAvailable: () => true },
      );
      expect(revised).toMatchObject({ ok: true });
      if (!revised.ok) {
        return;
      }
      const item = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.id, revised.workItemId))
        .get();
      const payload = JSON.parse(String(item?.payloadJson)) as Record<string, unknown>;
      expect(payload["schemaVersion"]).toBe("tailor-queue/v2");
      expect(payload["generationRequestId"]).toBe(revised.requestId);
      expect(payload["parentVersionId"]).toBe(world.v1Id);
      const request = t.handle.db
        .select()
        .from(generationRequests)
        .where(eq(generationRequests.id, revised.requestId))
        .get();
      expect(request).toMatchObject({
        requestKind: "REVISION",
        parentVersionId: world.v1Id,
        revisionNote: "The summary buries the B2B SaaS discovery wins; lead with them.",
      });
    });
  });
});
