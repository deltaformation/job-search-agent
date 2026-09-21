// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { candidateProfiles, workItems } from "../../../src/db";
import {
  getActiveProfileVersion,
  setDefaultProfile,
} from "../../../src/db/candidates";
import { IntakeBindingV1 } from "../../../src/domain/step2";
import { ingestClippedDom } from "../../../src/server/clip";
import { submitIntakeBatch } from "../../../src/server/intake";
import { readPreparationStatus } from "../../../src/server/preparation";
import type { DnsResolver } from "../../../src/scraping/ssrf";
import { S2B_JD, S2B_T0, seedS2bJob, withS2bDatabase } from "./s2b-world";

/**
 * WO-1.3-S2-B / S2B1: intake acceptance freezes the globally
 * selected profile version, approved evidence, and master before
 * asynchronous scraping. Later profile edits, default switches,
 * resubmissions, and duplicate clips never retarget the capture.
 */

function publicResolver(): DnsResolver {
  return async () => ["93.184.216.34"];
}

describe("S2B1 intake capture", () => {
  it("paste acceptance captures the default profile version and evidence", async () => {
    await withS2bDatabase(async (t, world) => {
      const result = await submitIntakeBatch({
        handle: t.handle,
        resolveHost: publicResolver(),
        lines: ["https://example.com/jobs/s2b-capture-1"],
      });
      expect(result.counts.enqueuedCount).toBe(1);
      const itemId = result.results[0].intakeItemId;
      const { readPreparationByIntakeItem } = await import("../../../src/db/step2");
      const row = readPreparationByIntakeItem(t.handle, itemId);
      expect(row).not.toBeNull();
      expect(row?.jobId).toBeNull();
      expect(row?.state).toBe("PENDING");
      const binding = IntakeBindingV1.parse(JSON.parse(row?.bindingJson as string));
      expect(binding.profileId).toBe(world.pmProfileId);
      expect(binding.profileVersionId).toBe(world.pmVersionId);
      expect(binding.intakeItemId).toBe(itemId);
      expect(binding.batchId).toBe(result.batchId);
      // The captured version is the ACTIVE one at acceptance time.
      const active = getActiveProfileVersion(t.handle, world.pmProfileId);
      expect(active?.id).toBe(world.pmVersionId);
    });
  });

  it("missing default profile captures nothing and still enqueues the scrape", async () => {
    await withS2bDatabase(async (t) => {
      t.handle.db.update(candidateProfiles).set({ isDefault: false }).run();
      const result = await submitIntakeBatch({
        handle: t.handle,
        resolveHost: publicResolver(),
        lines: ["https://example.com/jobs/s2b-no-default"],
      });
      expect(result.counts.enqueuedCount).toBe(1);
      const { readPreparationByIntakeItem } = await import("../../../src/db/step2");
      expect(
        readPreparationByIntakeItem(t.handle, result.results[0].intakeItemId),
      ).toBeNull();
      const items = t.handle.db
        .select()
        .from(workItems)
        .where(eq(workItems.kind, "SCRAPE"))
        .all();
      expect(items).toHaveLength(1);
    });
  });

  it("default switch and new versions after enqueue do not retarget the capture", async () => {
    await withS2bDatabase(async (t, world) => {
      const result = await submitIntakeBatch({
        handle: t.handle,
        resolveHost: publicResolver(),
        lines: ["https://example.com/jobs/s2b-frozen"],
      });
      const itemId = result.results[0].intakeItemId;
      // Operator switches the global default and activates a new PM
      // version while the scrape is still queued.
      expect(setDefaultProfile(t.handle, world.spmProfileId)).toBe(true);
      const { importCandidate, activateProfileVersion } = await import(
        "../../../src/server/candidates"
      );
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const document = JSON.parse(
        readFileSync(join(process.cwd(), "tests", "fixtures", "v1.2", "pm-profile.json"), "utf8"),
      ) as unknown;
      const imported = importCandidate(t.handle, {
        document,
        actor: "human",
        profileId: world.pmProfileId,
      });
      if (!imported.ok) {
        throw new Error("S2-B version seed failed");
      }
      const activated = activateProfileVersion(t.handle, {
        versionId: imported.versionId,
        actor: "human",
      });
      if (!activated.ok) {
        throw new Error("S2-B activation seed failed");
      }
      const { readPreparationByIntakeItem } = await import("../../../src/db/step2");
      const row = readPreparationByIntakeItem(t.handle, itemId);
      const binding = IntakeBindingV1.parse(JSON.parse(row?.bindingJson as string));
      expect(binding.profileId).toBe(world.pmProfileId);
      expect(binding.profileVersionId).toBe(world.pmVersionId);
    });
  });

  it("resubmission and duplicate URLs reuse the capture without rebinding", async () => {
    await withS2bDatabase(async (t) => {
      const first = await submitIntakeBatch({
        handle: t.handle,
        resolveHost: publicResolver(),
        lines: ["https://example.com/jobs/s2b-dedupe"],
      });
      const second = await submitIntakeBatch({
        handle: t.handle,
        resolveHost: publicResolver(),
        lines: ["https://example.com/jobs/s2b-dedupe"],
      });
      expect(second.results[0].outcome).toBe("DUPLICATE");
      const { readPreparationByIntakeItem } = await import("../../../src/db/step2");
      expect(
        readPreparationByIntakeItem(t.handle, first.results[0].intakeItemId),
      ).not.toBeNull();
      expect(
        readPreparationByIntakeItem(t.handle, second.results[0].intakeItemId),
      ).toBeNull();
      const { step2Preparations } = await import("../../../src/db/schema/step2");
      const rows = t.handle.db.select().from(step2Preparations).all();
      expect(rows).toHaveLength(1);
    });
  });

  it("clip acceptance captures before the synchronous persist links it", async () => {
    await withS2bDatabase(async (t, world) => {
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const evidenceDir = mkdtempSync(join(tmpdir(), "s2b-clip-"));
      // Deterministic key state: the clip path reads process.env.
      const saved = new Map<string, string | undefined>();
      for (const name of ["ACTIVE_AI_PROVIDER", "OPENROUTER_API_KEY", "GOOGLE_API_KEY", "META_API_KEY"]) {
        saved.set(name, process.env[name]);
        delete process.env[name];
      }
      try {
        const html = `<html><head><title>PM Clipped</title></head><body><h1>Product Manager</h1><p>${S2B_JD}</p></body></html>`;
        const clipped = ingestClippedDom(t.handle, {
          submittedUrl: "https://example.com/jobs/s2b-clip-1",
          html,
          title: "Product Manager - Example",
          source: "clip",
          evidenceDir,
          now: S2B_T0,
        });
        expect(clipped.outcome).toBe("created");
        if (clipped.outcome !== "created") {
          throw new Error("S2-B clip seed failed");
        }
        const { readPreparationByIntakeItem } = await import("../../../src/db/step2");
        const row = readPreparationByIntakeItem(t.handle, clipped.intakeItemId);
        expect(row).not.toBeNull();
        // No provider key: linked to the new job/extraction, still
        // PENDING for the explicit command.
        expect(row?.jobId).toBe(clipped.jobId);
        expect(row?.extractionId).not.toBeNull();
        expect(row?.state).toBe("PENDING");
        const binding = IntakeBindingV1.parse(JSON.parse(row?.bindingJson as string));
        expect(binding.profileVersionId).toBe(world.pmVersionId);
        const status = readPreparationStatus(t.handle, clipped.jobId, S2B_T0);
        expect(status?.state).toBe("PENDING");
        expect(status?.binding?.profileVersionId).toBe(world.pmVersionId);
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = value;
          }
        }
      }
    });
  });

  it("seeded legacy jobs report ABSENT until the explicit command", async () => {
    await withS2bDatabase(async (t, world) => {
      const basics = seedS2bJob(t.handle, world);
      const status = readPreparationStatus(t.handle, basics.jobId, S2B_T0);
      expect(status?.state).toBe("ABSENT");
      expect(status?.preparationId).toBeNull();
      expect(status?.retryAllowed).toBe(false);
    });
  });
});
