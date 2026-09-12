import { readFile } from "node:fs/promises";
import { getResumeArtifact } from "../../../../../src/server/review";
import { resolveDataRoot } from "../../../../../src/security/data-root";
import { resolveArtifactPath } from "../../../../../src/security/paths";
import { jsonError, openRequestDatabase, readGate } from "../../../_lib/request";
import { entityIdGate } from "../../../jobs/_lib/failures";

/**
 * Serve one resume artifact file by artifact id. Access resolves through
 * the database row and the allowlisted artifact root — never a
 * caller-supplied path. `?download=1` switches to an attachment with a
 * filename carrying the kind and extension; otherwise files render
 * inline under a sandboxing CSP plus nosniff.
 */
export const dynamic = "force-dynamic";

const KIND_EXTENSIONS: Record<string, string> = {
  MARKDOWN: "md",
  DOCX: "docx",
  PDF: "pdf",
};

interface ResumeArtifactRouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(
  request: Request,
  context: ResumeArtifactRouteContext,
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
    const download =
      new URL(request.url).searchParams.get("download") === "1";
    const headers = new Headers({
      "content-type": artifact.mediaType,
      "content-length": String(bytes.length),
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      "cache-control": "private, max-age=31536000, immutable",
    });
    if (download) {
      const extension = KIND_EXTENSIONS[artifact.kind] ?? "bin";
      headers.set(
        "content-disposition",
        `attachment; filename="resume-${artifact.kind.toLowerCase()}-${artifact.sha256.slice(0, 8)}.${extension}"`,
      );
    }
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  } finally {
    database.release();
  }
}
