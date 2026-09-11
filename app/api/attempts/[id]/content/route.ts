import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { workItems } from "../../../../../src/db/schema";
import { scrapeAttempts } from "../../../../../src/db/schema/jobs";
import { parseVersionedPayload } from "../../../../../src/domain/envelopes";
import { MAX_HTML_BYTES, MAX_TEXT_CHARS } from "../../../../../src/scraping/fetch";
import { resolveDataRoot } from "../../../../../src/security/data-root";
import { ingestClippedDom } from "../../../../../src/server/clip";
import {
  SCRAPE_PAYLOAD_VERSION,
  ScrapePayloadV1,
} from "../../../../../src/server/intake";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
} from "../../../_lib/request";

/**
 * Manual content fallback for one work item: when the automated scrape hit
 * a human-verification wall or produced nothing usable, the user pastes the
 * page content they can see and the clip pipeline ingests it. Same-origin
 * only (the app's own drawer), so the standard mutation gate applies.
 */
export const dynamic = "force-dynamic";

const ELIGIBLE_REASONS = ["CAPTCHA_REQUIRED", "EXTRACTION_INCOMPLETE"] as const;

const ContentBody = z
  .object({
    html: z.string().min(1),
    text: z.string().optional(),
  })
  .strict();

interface ContentRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: ContentRouteContext,
): Promise<Response> {
  const gate = mutationGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  if (id.trim() === "") {
    return jsonError(400, "invalid request", "work item id is empty");
  }
  const body = await parseJsonBody(request, ContentBody);
  if (!body.ok) {
    return body.response;
  }
  if (Buffer.byteLength(body.value.html, "utf8") > MAX_HTML_BYTES) {
    return jsonError(413, "content too large", `HTML exceeds ${MAX_HTML_BYTES} bytes`);
  }
  if (body.value.text !== undefined && body.value.text.length > MAX_TEXT_CHARS) {
    return jsonError(413, "content too large", `text exceeds ${MAX_TEXT_CHARS} characters`);
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const item = database.handle.db
      .select()
      .from(workItems)
      .where(eq(workItems.id, id))
      .get();
    if (item === undefined) {
      return jsonError(404, "work item not found");
    }
    let rawPayload: unknown = null;
    try {
      rawPayload =
        item.payloadJson === null ? null : (JSON.parse(item.payloadJson) as unknown);
    } catch {
      rawPayload = undefined;
    }
    const parsed = parseVersionedPayload(
      { [SCRAPE_PAYLOAD_VERSION]: ScrapePayloadV1 },
      rawPayload,
    );
    if (!parsed.ok) {
      return jsonError(400, "work item has no usable scrape payload", parsed.detail);
    }
    const payload = parsed.value as ScrapePayloadV1;
    const latest = database.handle.db
      .select({
        reasonCode: scrapeAttempts.reasonCode,
      })
      .from(scrapeAttempts)
      .where(eq(scrapeAttempts.canonicalUrl, payload.canonicalUrl))
      .orderBy(desc(scrapeAttempts.createdAt), desc(scrapeAttempts.id))
      .limit(1)
      .get();
    if (
      latest === undefined ||
      latest.reasonCode === null ||
      !(ELIGIBLE_REASONS as readonly string[]).includes(latest.reasonCode)
    ) {
      return jsonError(
        409,
        "content fallback not eligible",
        "manual content is only accepted after CAPTCHA_REQUIRED or EXTRACTION_INCOMPLETE",
      );
    }
    const result = ingestClippedDom(database.handle, {
      submittedUrl: payload.submittedUrl,
      html: body.value.html,
      selectedText: body.value.text,
      source: "paste",
      evidenceDir: resolveDataRoot(process.env).evidenceDir,
    });
    return Response.json(result);
  } finally {
    database.release();
  }
}
