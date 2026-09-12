import {
  BackupError,
  createBackupArchive,
} from "../../../src/server/backup";
import {
  makeStagingDir,
  resolveCandidateDir,
} from "../../../src/server/settings";
import {
  jsonError,
  openRequestDatabase,
  readGate,
  routePolicy,
} from "../_lib/request";
import { resolveDataRoot } from "../../../src/security/data-root";
import { runExclusive } from "../_lib/data-mgmt";

/**
 * One-click backup. `GET /api/backup` checkpoints WAL, copies the live
 * database through SQLite's online backup API, and downloads a
 * timestamped `.tar.gz` (database + evidence + artifacts + candidate).
 * `.env.local` and secrets are never included: the archive holds only
 * the four allowlisted roots. Serialized against restore/reset.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = readGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const paths = resolveDataRoot(process.env);
    const archive = await runExclusive(() =>
      createBackupArchive({
        handle: database.handle,
        paths,
        candidateDir: resolveCandidateDir(process.env),
        stagingDir: makeStagingDir("backup-download"),
        kind: "manual",
        now: new Date(),
      }),
    );
    const body = new Uint8Array(archive.bytes);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-length": String(archive.bytes.length),
        "content-disposition": `attachment; filename="${archive.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error: unknown) {
    if (error instanceof BackupError) {
      return jsonError(500, "backup failed", error.message);
    }
    throw error;
  } finally {
    database.release();
  }
}
