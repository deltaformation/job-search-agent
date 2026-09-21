import {
  BackupError,
  restoreArchive,
} from "../../../src/server/backup";
import { makeStagingDir } from "../../../src/server/settings";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  routePolicy,
} from "../_lib/request";
import {
  openDatabaseAt,
  resolveRoutePaths,
  runExclusive,
} from "../_lib/data-mgmt";

/**
 * Safe restore. `POST /api/restore` takes a multipart `archive` file
 * (`.tar.gz` from `GET /api/backup`), verifies it in staging, writes a
 * pre-restore rollback backup, then atomically swaps database +
 * evidence + artifacts + sources + candidate and bumps the worker generation so
 * the worker reopens without a restart. Serialized against backup/reset.
 */
export const dynamic = "force-dynamic";

/** Compressed upload cap; the tar codec separately caps the 1 GiB output. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "invalid request", "expected a multipart form upload");
  }
  const file = form.get("archive");
  if (!(file instanceof File)) {
    return jsonError(400, "invalid request", "multipart field \"archive\" is required");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return jsonError(400, "invalid request", "archive exceeds the 512 MiB upload limit");
  }
  const archive = Buffer.from(await file.arrayBuffer());
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const { paths, candidateDir, migrationsDir } = resolveRoutePaths();
    const result = await runExclusive(() =>
      restoreArchive({
        handle: database.handle,
        paths,
        candidateDir,
        stagingRoot: makeStagingDir("restore-upload"),
        migrationsDir,
        openStaging: openDatabaseAt,
        archive,
        now: new Date(),
      }),
    );
    // The live file was swapped; the handle below is only closed, never reused.
    return Response.json({
      jobs: result.jobs,
      preRestoreBackup: result.preRestoreBackup,
      restoredAt: result.manifest.createdAt,
      backupKind: result.manifest.kind,
    });
  } catch (error: unknown) {
    if (error instanceof BackupError) {
      return jsonError(400, "restore rejected", error.message);
    }
    throw error;
  } finally {
    database.release();
  }
}
