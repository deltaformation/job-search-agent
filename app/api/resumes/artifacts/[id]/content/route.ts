import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extractDocxParagraphs } from "../../../../../../src/resumes/docx";
import { escapeHtml } from "../../../../../../src/resumes/template";
import { getResumeArtifact } from "../../../../../../src/server/review";
import { resolveDataRoot } from "../../../../../../src/security/data-root";
import { resolveArtifactPath } from "../../../../../../src/security/paths";
import { jsonError, openRequestDatabase, readGate } from "../../../../_lib/request";
import { entityIdGate } from "../../../../jobs/_lib/failures";

/**
 * Canonical DOCX content preview (WO-1.2-F, F3): paragraph text
 * extracted from the stored DOCX bytes, rendered as escaped HTML in a
 * sandboxed page. This is a content preview, not a pixel-exact
 * rendering — the page links the original file for exact
 * formatting. Artifact access resolves through the database id and
 * the allowlisted artifact root, exactly like the file route.
 */
export const dynamic = "force-dynamic";

interface ArtifactContentRouteContext {
  params: Promise<{ id: string }>;
}

function contentPage(paragraphs: string[], artifactId: string): string {
  const body =
    paragraphs.length === 0
      ? "<p><em>No extractable text in this document.</em></p>"
      : paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Content preview — resume DOCX</title>
<style>body{font-family:system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;line-height:1.5}p.notice{border:1px solid #ccc;border-radius:0.5rem;padding:0.75rem 1rem;background:#f7f7f7;font-size:0.875rem}</style>
</head>
<body>
<p class="notice">Content preview — canonical text extracted from the stored DOCX file. Layout, fonts, and pagination may differ from the original. <a href="/api/resumes/artifacts/${escapeHtml(artifactId)}?download=1">Open original DOCX</a></p>
${body}
</body>
</html>
`;
}

export async function GET(
  request: Request,
  context: ArtifactContentRouteContext,
): Promise<Response> {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idGate = entityIdGate(id, "artifact id");
  if (idGate !== null) {
    return idGate;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const artifact = getResumeArtifact(database.handle, id);
    if (artifact === null) {
      return jsonError(404, "artifact not found");
    }
    if (artifact.kind !== "DOCX") {
      return jsonError(400, "content preview is only available for DOCX artifacts");
    }
    let absolute: string;
    try {
      const paths = resolveDataRoot(process.env);
      absolute = resolveArtifactPath(paths.artifactsDir, artifact.relativePath);
    } catch {
      return jsonError(500, "artifact path rejected");
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      return jsonError(500, "artifact bytes missing");
    }
    if (bytes.byteLength !== artifact.byteSize) {
      return jsonError(500, "artifact integrity failure");
    }
    const digest = createHash("sha256").update(bytes).digest();
    const expected = Buffer.from(artifact.sha256, "hex");
    if (digest.byteLength !== expected.byteLength || !timingSafeEqual(digest, expected)) {
      return jsonError(500, "artifact integrity failure");
    }
    let paragraphs: string[];
    try {
      paragraphs = extractDocxParagraphs(bytes);
    } catch {
      return jsonError(500, "artifact content unreadable");
    }
    const page = contentPage(paragraphs, artifact.id);
    return new Response(page, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } finally {
    database.release();
  }
}
