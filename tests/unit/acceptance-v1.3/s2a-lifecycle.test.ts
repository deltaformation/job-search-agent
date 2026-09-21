// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PREPARATION_NEVER_EMITS,
  PREPARATION_NON_RETRYABLE,
  PREPARATION_STAGE_ORDER,
  PreparationFailure,
  Step2ErrorCode,
  planPreparationTransition,
  resolvePrepareReplay,
  type PreparationEvent,
  type PreparationRowState,
} from "../../../src/domain/step2";
import { prepareOperationHashFor } from "../../../src/tailoring/step2policy";

/**
 * WO-1.3-S2-A / S2A2: the operation matrix decision tables — state
 * transitions, idempotent replay, and the code/stage pins that S2-B
 * services and routes implement.
 */

describe("S2A2 preparation state machine", () => {
  const states: PreparationRowState[] = [
    "PENDING",
    "QUEUED",
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
  ];
  const events: PreparationEvent[] = [
    "schedule",
    "claim",
    "succeed",
    "fail",
    "retry",
    "supersede",
  ];
  const allowed: Record<PreparationRowState, PreparationEvent[]> = {
    PENDING: ["schedule"],
    QUEUED: ["claim", "schedule"],
    RUNNING: ["succeed", "fail"],
    SUCCEEDED: ["supersede"],
    FAILED: ["retry", "schedule", "supersede"],
  };
  const targets: Record<string, PreparationRowState> = {
    "PENDING/schedule": "QUEUED",
    "QUEUED/claim": "RUNNING",
    "QUEUED/schedule": "QUEUED",
    "RUNNING/succeed": "SUCCEEDED",
    "RUNNING/fail": "FAILED",
    "SUCCEEDED/supersede": "QUEUED",
    "FAILED/retry": "QUEUED",
    "FAILED/schedule": "QUEUED",
    "FAILED/supersede": "QUEUED",
  };

  for (const from of states) {
    for (const event of events) {
      const key = `${from}/${event}`;
      if (allowed[from].includes(event)) {
        it(`permits ${key} -> ${targets[key]}`, () => {
          expect(planPreparationTransition(from, event)).toEqual({
            ok: true,
            to: targets[key],
          });
        });
      } else {
        it(`refuses ${key}`, () => {
          const result = planPreparationTransition(from, event);
          expect(result.ok).toBe(false);
        });
      }
    }
  }

  it("terminal RUNNING work never returns to PENDING or skips QUEUED", () => {
    expect(planPreparationTransition("RUNNING", "retry").ok).toBe(false);
    expect(planPreparationTransition("RUNNING", "schedule").ok).toBe(false);
    expect(planPreparationTransition("PENDING", "claim").ok).toBe(false);
    expect(planPreparationTransition("QUEUED", "succeed").ok).toBe(false);
  });
});

describe("S2A2 P idempotency decisions", () => {
  const base = {
    jobId: "job-1",
    operationId: "op-1",
    observedRowVersion: 4,
    profileId: null as string | null,
  };
  const hash = prepareOperationHashFor(base);

  it("accepts first use and unknown operation ids", () => {
    expect(
      resolvePrepareReplay({
        lastOperationId: null,
        lastOperationHash: null,
        operationId: base.operationId,
        operationHash: hash,
      }),
    ).toBe("accept");
    expect(
      resolvePrepareReplay({
        lastOperationId: "op-0",
        lastOperationHash: hash,
        operationId: base.operationId,
        operationHash: hash,
      }),
    ).toBe("accept");
  });

  it("replays identical bytes and conflicts on changed bytes", () => {
    const row = {
      lastOperationId: base.operationId,
      lastOperationHash: hash,
    };
    expect(
      resolvePrepareReplay({ ...row, operationId: "op-1", operationHash: hash }),
    ).toBe("replay");
    const changed = prepareOperationHashFor({ ...base, observedRowVersion: 5 });
    expect(changed).not.toBe(hash);
    expect(
      resolvePrepareReplay({
        ...row,
        operationId: "op-1",
        operationHash: changed,
      }),
    ).toBe("mismatch");
  });

  it("operation hash binds job, operation, row version, and profile", () => {
    const variants = [
      { ...base, jobId: "job-2" },
      { ...base, operationId: "op-2" },
      { ...base, observedRowVersion: 5 },
      { ...base, profileId: "pm" },
    ];
    for (const variant of variants) {
      expect(prepareOperationHashFor(variant)).not.toBe(hash);
    }
    expect(prepareOperationHashFor({ ...base })).toBe(hash);
  });
});

describe("S2A2 code, stage, and retry partitions", () => {
  it("stages are exactly the five ordered boundaries", () => {
    expect([...PREPARATION_STAGE_ORDER]).toEqual([
      "LOADING_INPUTS",
      "WAITING_FOR_PROVIDER",
      "VALIDATING_PROPOSAL",
      "STORING_PLAN",
      "PUBLISHING_PLAN",
    ]);
  });

  it("retryable/non-retryable/never-emit partition the 14 codes", () => {
    const codes = new Set(PreparationFailure.shape.code.options);
    expect(codes.size).toBe(14);
    for (const code of PREPARATION_NON_RETRYABLE) {
      expect(codes.has(code)).toBe(true);
    }
    for (const code of PREPARATION_NEVER_EMITS) {
      expect(codes.has(code)).toBe(true);
    }
    expect(
      new Set([...PREPARATION_NON_RETRYABLE, ...PREPARATION_NEVER_EMITS]).size,
    ).toBe(4);
  });

  it("new error codes are disjoint from the generation set", () => {
    const generationCodes = new Set([
      "INVALID_REQUEST",
      "FORBIDDEN",
      "NOT_FOUND",
      "PRECONDITION_REQUIRED",
      "WORKSPACE_CONFLICT",
      "JOB_CONFLICT",
      "INPUT_STALE",
      "GENERATION_BUSY",
      "IDEMPOTENCY_MISMATCH",
      "PROFILE_NOT_READY",
      "JD_NOT_READY",
      "PROVIDER_NOT_READY",
      "INVALID_SELECTION",
      "REVIEW_NOT_ALLOWED",
      "RETRY_NOT_ALLOWED",
      "ARTIFACT_INTEGRITY",
      "STORAGE_UNAVAILABLE",
    ]);
    for (const code of Step2ErrorCode.options) {
      expect(generationCodes.has(code)).toBe(false);
    }
  });
});
