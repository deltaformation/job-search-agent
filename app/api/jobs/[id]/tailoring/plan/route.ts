import { NextResponse } from "next/server";
import {
  openTailoringDatabase,
  tailoringError,
  tailoringJson,
  tailoringPathId,
  tailoringReadGate,
} from "@/app/api/_lib/tailoring";
import { PlanReplyV1 } from "@/src/domain/step2";
import { PlanReplyV2 } from "@/src/domain/step2Correction";
import { readPlanForJob, type PreparationFailure } from "@/src/server/preparation";

interface PlanRouteContext {
  params: Promise<{ id: string }>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: PlanRouteContext) {
  const gate = tailoringReadGate(request, process.env);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idCheck = tailoringPathId(id);
  if (!idCheck.ok) {
    return idCheck.response;
  }
  const url = new URL(request.url);
  const planId = url.searchParams.get("planId");
  if (planId !== null && !UUID_PATTERN.test(planId)) {
    return tailoringError(400, "INVALID_REQUEST", "planId must be a UUID");
  }
  const db = openTailoringDatabase(process.env);
  if (!db.ok) {
    return db.response;
  }
  try {
    const result = readPlanForJob(db.handle, id, planId);
    if (!result.ok) {
      const failure: PreparationFailure = result;
      switch (failure.error) {
        case "job-not-found":
        case "plan-not-found":
          return tailoringError(404, "NOT_FOUND", failure.message);
        case "plan-stale":
          // The stale plan id rides along for diagnostics; the
          // envelope stays the standard error shape.
          return NextResponse.json(
            {
              ok: false,
              error: {
                code: "PLAN_STALE",
                message: failure.message.slice(0, 280),
                action: null,
              },
              planId: failure.planId ?? null,
            },
            { status: 409, headers: { "Cache-Control": "no-store" } },
          );
        default:
          return tailoringError(503, "STORAGE_UNAVAILABLE", failure.message);
      }
    }
    // S2-CP-B: v2 plans return PlanReplyV2 with server-derived
    // eligible roles; v1 plans keep PlanReplyV1 byte-for-byte.
    if (result.value.version === 2) {
      return tailoringJson(
        200,
        PlanReplyV2.parse({
          ok: true,
          plan: result.value.plan,
          eligibleRoles: result.value.eligibleRoles,
          planHash: result.value.planHash,
          validatedAt: result.value.validatedAt,
          supersedesPlanId: result.value.supersedesPlanId,
        }),
      );
    }
    return tailoringJson(
      200,
      PlanReplyV1.parse({
        ok: true,
        plan: result.value.plan,
        planHash: result.value.planHash,
        validatedAt: result.value.validatedAt,
        supersedesPlanId: result.value.supersedesPlanId,
      }),
    );
  } finally {
    db.close();
  }
}
