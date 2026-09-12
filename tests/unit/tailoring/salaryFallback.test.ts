// @vitest-environment node
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createTestDatabase,
  newId,
  type DatabaseHandle,
  type TestDatabase,
} from "../../../src/db";
import { jobExtractions, jobs, scrapeAttempts } from "../../../src/db/schema";
import {
  backfillJobSalary,
  runSalaryFallback,
  SALARY_FACTS_VERSION,
  SalaryFactsV1,
} from "../../../src/tailoring/salaryFallback";

function validFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SALARY_FACTS_VERSION,
    salaryMinMinor: 14590000,
    salaryMaxMinor: 19740000,
    currency: "CAD",
    salaryText: "$145,900 - $197,400 CAD per year",
    isHourlyOrDaily: false,
    compensationHighlights: ["Stock options / Equity", "RRSP matching"],
    model: "google/gemma-4-26b-a4b-it:free",
    ...overrides,
  };
}

describe("SalaryFactsV1", () => {
  it("accepts a full valid payload", () => {
    expect(SalaryFactsV1.parse(validFacts()).salaryMaxMinor).toBe(19740000);
  });

  it("accepts empty facts and hourly facts without minors", () => {
    const empty = SalaryFactsV1.parse(
      validFacts({
        salaryMinMinor: null,
        salaryMaxMinor: null,
        currency: null,
        salaryText: null,
        compensationHighlights: [],
        model: null,
      }),
    );
    expect(empty.salaryText).toBeNull();
    const hourly = SalaryFactsV1.parse(
      validFacts({
        salaryMinMinor: null,
        salaryMaxMinor: null,
        currency: "USD",
        salaryText: "$75 - $95 / hr",
        isHourlyOrDaily: true,
      }),
    );
    expect(hourly.isHourlyOrDaily).toBe(true);
  });

  it("rejects inverted ranges, hourly minors, bad currency, and unknown keys", () => {
    expect(() =>
      SalaryFactsV1.parse(validFacts({ salaryMinMinor: 20000000, salaryMaxMinor: 10000000 })),
    ).toThrow();
    expect(() =>
      SalaryFactsV1.parse(validFacts({ isHourlyOrDaily: true, salaryMinMinor: 7500 })),
    ).toThrow();
    expect(() => SalaryFactsV1.parse(validFacts({ currency: "JPY" }))).toThrow();
    expect(() => SalaryFactsV1.parse(validFacts({ salaryMidpoint: 170000 }))).toThrow();
    expect(() => SalaryFactsV1.parse(validFacts({ schemaVersion: "salary-facts/v9" }))).toThrow();
  });
});

describe("runSalaryFallback", () => {
  const REQUEST = {
    jobTitle: "PM",
    company: "Jobber",
    location: "Toronto, ON",
    jdText: "Salary $145,900 - $197,400 CAD per year.",
  };

  function echoFacts(factsJson: string): string {
    return `let s="";process.stdin.on("data",c=>{s+=c});process.stdin.on("end",()=>{if(!s.includes("Toronto")){process.exit(9)}process.stdout.write(${JSON.stringify(factsJson)})});`;
  }

  it("resolves parsed facts from a well-behaved sidecar", async () => {
    const facts = await runSalaryFallback({
      config: {
        argv: [process.execPath, "-e", echoFacts(JSON.stringify(validFacts()))],
        timeoutMs: 5000,
        maxOutputBytes: 65_536,
      },
      request: REQUEST,
    });
    expect(facts).toMatchObject({ salaryMinMinor: 14590000, currency: "CAD" });
  });

  it("resolves null on every failure mode without throwing", async () => {
    const diagnosed: string[] = [];
    const diagnose = (message: string): void => {
      diagnosed.push(message);
    };
    const cases: Array<{ name: string; argv: string[]; timeoutMs: number; maxOutputBytes: number }> = [
      { name: "exit", argv: [process.execPath, "-e", "process.exit(3)"], timeoutMs: 5000, maxOutputBytes: 65_536 },
      { name: "spawn", argv: ["/nonexistent-salary-binary-xyz"], timeoutMs: 5000, maxOutputBytes: 65_536 },
      { name: "timeout", argv: [process.execPath, "-e", "setTimeout(()=>{},10000)"], timeoutMs: 200, maxOutputBytes: 65_536 },
      { name: "cap", argv: [process.execPath, "-e", `process.stdout.write("x".repeat(100000))`], timeoutMs: 5000, maxOutputBytes: 1024 },
      { name: "json", argv: [process.execPath, "-e", `process.stdout.write("nope{")`], timeoutMs: 5000, maxOutputBytes: 65_536 },
      { name: "schema", argv: [process.execPath, "-e", echoFacts(JSON.stringify({ wrong: 1 }))], timeoutMs: 5000, maxOutputBytes: 65_536 },
      { name: "empty-argv", argv: [], timeoutMs: 5000, maxOutputBytes: 65_536 },
    ];
    for (const failure of cases) {
      const before = diagnosed.length;
      const facts = await runSalaryFallback({ config: failure, request: REQUEST, onDiagnostic: diagnose });
      expect(facts, failure.name).toBeNull();
      expect(diagnosed.length, `${failure.name} diagnosed`).toBeGreaterThan(before);
    }
  });
});

describe("backfillJobSalary", () => {
  function withDatabase(fn: (t: TestDatabase) => void): void {
    const t = createTestDatabase("job-tracker-salary-backfill-test-");
    try {
      fn(t);
    } finally {
      t.cleanup();
    }
  }

  function seedJob(
    handle: DatabaseHandle,
    overrides: {
      salaryText?: string | null;
      compensationHighlightsJson?: string | null;
    } = {},
  ): { jobId: string; extractionId: string } {
    const jobId = newId();
    handle.db
      .insert(jobs)
      .values({
        id: jobId,
        status: "NEW",
        rank: 0,
        rowVersion: 7,
        title: "PM",
        company: "Jobber",
        location: "Toronto, ON",
        descriptionText: "Salary $145,900 - $197,400 CAD per year.",
        salaryText: overrides.salaryText ?? null,
        compensationHighlightsJson: overrides.compensationHighlightsJson ?? null,
        createdAt: "2026-09-11T12:00:00.000Z",
        updatedAt: "2026-09-11T12:00:00.000Z",
      })
      .run();
    const attemptId = newId();
    handle.db
      .insert(scrapeAttempts)
      .values({
        id: attemptId,
        jobId,
        canonicalUrl: "https://example.com/jobs/1",
        adapter: "generic",
        startedAt: "2026-09-11T12:00:00.000Z",
        finishedAt: "2026-09-11T12:00:05.000Z",
        outcome: "SUCCEEDED",
        workerId: "worker-a",
      })
      .run();
    const extractionId = newId();
    handle.db
      .insert(jobExtractions)
      .values({
        id: extractionId,
        jobId,
        scrapeAttemptId: attemptId,
        version: 1,
        schemaVersion: "job-extraction-v1",
        adapter: "generic",
        extractedJson: JSON.stringify({
          schemaVersion: "job-extraction-v1",
          fields: {},
          provenance: {},
          contentHash: "b".repeat(64),
        }),
        confidence: 0.8,
        missingFieldsJson: JSON.stringify([]),
      })
      .run();
    handle.db
      .update(jobs)
      .set({ activeExtractionId: extractionId })
      .where(eq(jobs.id, jobId))
      .run();
    return { jobId, extractionId };
  }

  function readJob(handle: DatabaseHandle, jobId: string) {
    return handle.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  }

  it("writes salary and highlights without bumping the row version", () => {
    withDatabase((t) => {
      const { jobId, extractionId } = seedJob(t.handle);
      const outcome = backfillJobSalary(t.handle, {
        jobId,
        extractionId,
        facts: SalaryFactsV1.parse(validFacts()),
      });
      expect(outcome).toBe("written");
      const job = readJob(t.handle, jobId);
      expect(job).toMatchObject({
        salaryText: "$145,900 - $197,400 CAD per year",
        salaryCurrency: "CAD",
        salaryMinMinor: 14590000,
        salaryMaxMinor: 19740000,
        compensationHighlightsJson: JSON.stringify(["Stock options / Equity", "RRSP matching"]),
        rowVersion: 7,
      });
    });
  });

  it("skips present salary, drifted extractions, and empty facts", () => {
    withDatabase((t) => {
      const present = seedJob(t.handle, { salaryText: "USD 100000-150000" });
      expect(
        backfillJobSalary(t.handle, {
          jobId: present.jobId,
          extractionId: present.extractionId,
          facts: SalaryFactsV1.parse(validFacts()),
        }),
      ).toBe("skipped-present");
      expect(readJob(t.handle, present.jobId)?.salaryText).toBe("USD 100000-150000");

      const drifted = seedJob(t.handle);
      expect(
        backfillJobSalary(t.handle, {
          jobId: drifted.jobId,
          extractionId: newId(),
          facts: SalaryFactsV1.parse(validFacts()),
        }),
      ).toBe("skipped-drift");
      expect(readJob(t.handle, drifted.jobId)?.salaryText).toBeNull();

      const empty = seedJob(t.handle);
      expect(
        backfillJobSalary(t.handle, {
          jobId: empty.jobId,
          extractionId: empty.extractionId,
          facts: SalaryFactsV1.parse(
            validFacts({
              salaryMinMinor: null,
              salaryMaxMinor: null,
              currency: null,
              salaryText: null,
              compensationHighlights: [],
              model: null,
            }),
          ),
        }),
      ).toBe("skipped-empty");
      expect(
        backfillJobSalary(t.handle, { jobId: newId(), extractionId: newId(), facts: SalaryFactsV1.parse(validFacts()) }),
      ).toBe("skipped-missing-job");
    });
  });

  it("preserves stored highlights when the facts carry none", () => {
    withDatabase((t) => {
      const stored = JSON.stringify(["Health stipend"]);
      const { jobId, extractionId } = seedJob(t.handle, { compensationHighlightsJson: stored });
      const outcome = backfillJobSalary(t.handle, {
        jobId,
        extractionId,
        facts: SalaryFactsV1.parse(validFacts({ compensationHighlights: [] })),
      });
      expect(outcome).toBe("written");
      expect(readJob(t.handle, jobId)?.compensationHighlightsJson).toBe(stored);
    });
  });
});
