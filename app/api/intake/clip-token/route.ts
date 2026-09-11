import { getClipToken } from "../../../../src/security/clip-token";
import { resolveDataRoot } from "../../../../src/security/data-root";
import { jsonError, readGate } from "../../_lib/request";

/**
 * Same-origin clip-token display for the intake page: the user copies the
 * token into the extension options or uses the personalized bookmarklet.
 * Host-gated and served without CORS headers, so only the local app (and
 * local processes) can read it — never a remote website.
 */
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const gate = readGate(request);
  if (gate !== null) {
    return gate;
  }
  try {
    const { root } = resolveDataRoot(process.env);
    return Response.json({ token: getClipToken(root) });
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return jsonError(500, "data root misconfigured", detail);
  }
}
