// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CommandProvider, runCommandJson } from "../../../src/tailoring/commandAdapter";
import {
  RESUME_PROPOSAL_SCHEMA_VERSION,
  TAILOR_PROMPT_VERSION,
  TAILORING_INPUT_SCHEMA_VERSION,
  ProviderError,
  type TailoringInputV1,
} from "../../../src/tailoring/contract";

const INPUT: TailoringInputV1 = {
  schemaVersion: TAILORING_INPUT_SCHEMA_VERSION,
  jobId: "job-cmd-1",
  jobTitle: "Engineer",
  company: "Acme",
  jdSnapshotId: "jd-cmd-1",
  jdText: "Build TypeScript APIs.",
  candidateSnapshotId: "cs-cmd-1",
  profile: {
    full_name: "Cmd Candidate",
    target_titles: [],
    work_experience: [],
    verified_facts: [],
    skills: [],
    education: [],
  },
  approvedFactIds: [],
  promptVersion: TAILOR_PROMPT_VERSION,
};

function echoScript(proposalJson: string): string {
  // Reads stdin to completion (proving the envelope was delivered),
  // then prints the canned proposal. No network, no filesystem.
  return `let s="";process.stdin.on("data",c=>{s+=c});process.stdin.on("end",()=>{if(!s.includes("tailoring-input/v1")){process.exit(9)}process.stdout.write(${JSON.stringify(proposalJson)})});`;
}

function validProposal(): Record<string, unknown> {
  return {
    schemaVersion: RESUME_PROPOSAL_SCHEMA_VERSION,
    jdSnapshotId: "jd-cmd-1",
    candidateSnapshotId: "cs-cmd-1",
    requirements: [
      {
        requirement_id: "req_1",
        jd_quote: "Build TypeScript APIs.",
        category: "skill",
        importance: "required",
        match_status: "gap",
        evidence_fact_ids: [],
        evidence_quotes: [],
        review_status: "proposed",
      },
    ],
    rationale: "One gap.",
    questions: [],
  };
}

describe("command provider adapter", () => {
  it("round-trips a proposal with full attempt lineage", async () => {
    const provider = new CommandProvider({
      argv: [process.execPath, "-e", echoScript(JSON.stringify(validProposal()))],
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      model: "local-stub",
    });
    const { proposal, attempt } = await provider.prepare(INPUT);
    expect(proposal.requirements).toHaveLength(1);
    expect(proposal.rationale).toBe("One gap.");
    expect(attempt.providerId).toBe("command");
    expect(attempt.model).toBe("local-stub");
    expect(attempt.executable).toBe(process.execPath);
    expect(attempt.argvHash).toBe(provider.argvHash());
    expect(attempt.argvHash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt.configVersion).toBe("command-adapter/v1");
    expect(attempt.exitCode).toBe(0);
    expect(attempt.timedOut).toBe(false);
    expect(attempt.outputBytes).toBeGreaterThan(0);
    expect(attempt.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(attempt.proposalHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces stable argv hashes", () => {
    const first = new CommandProvider({ argv: ["/bin/agent", "--mode", "x"] });
    const second = new CommandProvider({ argv: ["/bin/agent", "--mode", "x"] });
    const other = new CommandProvider({ argv: ["/bin/agent", "--mode", "y"] });
    expect(first.argvHash()).toBe(second.argvHash());
    expect(first.argvHash()).not.toBe(other.argvHash());
  });

  it("rejects non-JSON stdout", async () => {
    const provider = new CommandProvider({
      argv: [process.execPath, "-e", `process.stdout.write("hello not json")`],
    });
    const error = await provider.prepare(INPUT).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).reason).toBe("PROVIDER_UNAVAILABLE");
    expect((error as ProviderError).detail).toContain("not JSON");
  });

  it("rejects schema-invalid proposals with paths, not values", async () => {
    const bad = { ...validProposal(), approval: "APPROVED" };
    const provider = new CommandProvider({
      argv: [process.execPath, "-e", echoScript(JSON.stringify(bad))],
    });
    const error = await provider.prepare(INPUT).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).detail).toContain("schema validation");
    expect((error as ProviderError).detail).not.toContain("APPROVED");
  });

  it("maps non-zero exits without persisting stderr", async () => {
    const provider = new CommandProvider({
      argv: [
        process.execPath,
        "-e",
        `process.stderr.write("secret chain of thought");process.exit(3)`,
      ],
    });
    const error = await provider.prepare(INPUT).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).reason).toBe("PROVIDER_UNAVAILABLE");
    expect((error as ProviderError).detail).toContain("exited with status 3");
    expect((error as ProviderError).detail).not.toContain("secret");
  });

  it.each([
    { code: 10, reason: "PROVIDER_UNAVAILABLE", detail: "authentication failed" },
    { code: 11, reason: "PROVIDER_UNAVAILABLE", detail: "rate limit" },
    { code: 12, reason: "TIMEOUT", detail: "timed out" },
    { code: 13, reason: "PROVIDER_UNAVAILABLE", detail: "unusable response" },
  ])("maps classified exit $code to $reason", async ({ code, reason, detail }) => {
    const provider = new CommandProvider({
      argv: [process.execPath, "-e", `process.exit(${code})`],
    });
    const error = await provider.prepare(INPUT).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).reason).toBe(reason);
    expect((error as ProviderError).detail).toContain(detail);
  });

  it("kills hung providers with TIMEOUT", async () => {
    const provider = new CommandProvider({
      argv: [process.execPath, "-e", `setTimeout(()=>{},10000)`],
      timeoutMs: 300,
    });
    const started = Date.now();
    const error = await provider.prepare(INPUT).catch((cause: unknown) => cause);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).reason).toBe("TIMEOUT");
  });

  it("kills providers that exceed the output cap", async () => {
    const provider = new CommandProvider({
      argv: [process.execPath, "-e", `process.stdout.write("x".repeat(100000))`],
      maxOutputBytes: 1024,
    });
    const error = await provider.prepare(INPUT).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).reason).toBe("PROVIDER_UNAVAILABLE");
    expect((error as ProviderError).detail).toContain("output bytes");
  });

  it("maps missing executables without a shell", async () => {
    const provider = new CommandProvider({ argv: ["/nonexistent/agent-binary-xyz"] });
    const error = await provider.prepare(INPUT).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).reason).toBe("PROVIDER_UNAVAILABLE");
    expect((error as ProviderError).detail).toContain("spawn failed");
  });

  it("rejects empty stdout", async () => {
    const provider = new CommandProvider({
      argv: [process.execPath, "-e", `/* no output */`],
    });
    const error = await provider.prepare(INPUT).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).detail).toContain("empty");
  });

  it("validates its own configuration", () => {
    expect(() => new CommandProvider({ argv: [] })).toThrow();
    expect(() => new CommandProvider({ argv: ["", "x"] })).toThrow();
    expect(() => new CommandProvider({ argv: ["x"], timeoutMs: 0 })).toThrow();
    expect(() => new CommandProvider({ argv: ["x"], maxOutputBytes: 10 })).toThrow();
  });
});

describe("runCommandJson", () => {
  it("resolves stdout for a well-behaved sidecar", async () => {
    const stdout = await runCommandJson({
      argv: [
        process.execPath,
        "-e",
        `let s="";process.stdin.on("data",c=>{s+=c});process.stdin.on("end",()=>{if(!s.includes("ping")){process.exit(9)}process.stdout.write(JSON.stringify({ok:true}))});`,
      ],
      stdin: JSON.stringify({ probe: "ping" }),
      timeoutMs: 5000,
      maxOutputBytes: 65_536,
    });
    expect(stdout).toBe(JSON.stringify({ ok: true }));
  });

  it("resolves null on every failure mode without throwing", async () => {
    const diagnosed: string[] = [];
    const diagnose = (message: string): void => {
      diagnosed.push(message);
    };
    const cases: Array<{ name: string; argv: string[]; timeoutMs: number; maxOutputBytes: number }> = [
      { name: "exit", argv: [process.execPath, "-e", "process.exit(3)"], timeoutMs: 5000, maxOutputBytes: 65_536 },
      { name: "spawn", argv: ["/nonexistent-sidecar-binary-xyz"], timeoutMs: 5000, maxOutputBytes: 65_536 },
      { name: "timeout", argv: [process.execPath, "-e", "setTimeout(()=>{},10000)"], timeoutMs: 200, maxOutputBytes: 65_536 },
      { name: "cap", argv: [process.execPath, "-e", `process.stdout.write("x".repeat(100000))`], timeoutMs: 5000, maxOutputBytes: 1024 },
      { name: "empty", argv: [process.execPath, "-e", ""], timeoutMs: 5000, maxOutputBytes: 65_536 },
      { name: "empty-argv", argv: [], timeoutMs: 5000, maxOutputBytes: 65_536 },
    ];
    for (const failure of cases) {
      const before = diagnosed.length;
      const stdout = await runCommandJson({
        argv: failure.argv,
        stdin: "{}",
        timeoutMs: failure.timeoutMs,
        maxOutputBytes: failure.maxOutputBytes,
        onDiagnostic: diagnose,
      });
      expect(stdout, failure.name).toBeNull();
      expect(diagnosed.length, `${failure.name} diagnosed`).toBeGreaterThan(before);
    }
  });
});
