import { z } from "zod";
import { MAX_HTML_BYTES, MAX_TEXT_CHARS } from "../../../../src/scraping/fetch";
import { MAX_URL_LENGTH } from "../../../../src/scraping/urls";
import { verifyClipToken } from "../../../../src/security/clip-token";
import { resolveDataRoot } from "../../../../src/security/data-root";
import { ingestClippedDom } from "../../../../src/server/clip";
import { jsonError, openRequestDatabase, parseJsonBody } from "../../_lib/request";

/**
 * Cross-origin DOM intake for the browser clipper and bookmarklet. This is
 * the one mutation that cannot use the Origin gate: captures arrive from
 * arbitrary job-board origins by design, so a per-data-root bearer token
 * (possession proves the localhost user configured the capture tool)
 * replaces Origin checking. The Host gate still applies via middleware, no
 * cookies or credentials are involved, and oversized bodies are rejected
 * before ingestion. Domain outcomes (created/duplicate/rejected) all
 * return 200 with a reason-coded body, mirroring URL intake.
 */
export const dynamic = "force-dynamic";

const ClipBody = z
  .object({
    url: z.string().min(1).max(MAX_URL_LENGTH),
    html: z.string().min(1),
    title: z.string().max(2000).optional(),
    selectedText: z.string().optional(),
  })
  .strict();

/** Rejects bodies that cannot fit even before JSON parsing. */
const MAX_BODY_BYTES = MAX_HTML_BYTES + 65_536;

function clipCorsHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
  });
}

function withClipCors(response: Response): Response {
  for (const [name, value] of clipCorsHeaders()) {
    response.headers.set(name, value);
  }
  return response;
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: clipCorsHeaders() });
}

export async function POST(request: Request): Promise<Response> {
  let root: string;
  try {
    root = resolveDataRoot(process.env).root;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return withClipCors(jsonError(500, "data root misconfigured", detail));
  }
  if (!verifyClipToken(root, request.headers.get("authorization"))) {
    return withClipCors(
      jsonError(401, "unauthorized", "clip bearer token missing or invalid"),
    );
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.isSafeInteger(Number(contentLength)) &&
    Number(contentLength) > MAX_BODY_BYTES
  ) {
    return withClipCors(jsonError(413, "clip body too large"));
  }
  const body = await parseJsonBody(request, ClipBody);
  if (!body.ok) {
    return withClipCors(body.response);
  }
  if (Buffer.byteLength(body.value.html, "utf8") > MAX_HTML_BYTES) {
    return withClipCors(
      jsonError(413, "clip body too large", `HTML exceeds ${MAX_HTML_BYTES} bytes`),
    );
  }
  if (
    body.value.selectedText !== undefined &&
    body.value.selectedText.length > MAX_TEXT_CHARS
  ) {
    return withClipCors(
      jsonError(413, "clip body too large", `text exceeds ${MAX_TEXT_CHARS} characters`),
    );
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return withClipCors(database.response);
  }
  try {
    const result = ingestClippedDom(database.handle, {
      submittedUrl: body.value.url,
      html: body.value.html,
      title: body.value.title,
      selectedText: body.value.selectedText,
      source: "clip",
      evidenceDir: resolveDataRoot(process.env).evidenceDir,
    });
    return withClipCors(Response.json(result));
  } finally {
    database.release();
  }
}
