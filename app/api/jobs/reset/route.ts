import { z } from "zod";
import { BackupError, resetBoardData } from "../../../../src/server/backup";
import { makeStagingDir } from "../../../../src/server/settings";
import {
  jsonError,
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
  routePolicy,
} from "../../_lib/request";
import {
  openDatabaseAt,
  resolveRoutePaths,
  runExclusive,
  runMigrationsAt,
} from "../../_lib/data-mgmt";

/**
 * Safe board reset ("Clear All Jobs"). Requires `{ "confirm": "RESET" }`
 * so an accidental click cannot wipe the board. Takes a pre-reset
 * backup, rebuilds an empty migrated database that keeps only the five
 * candidate tables, empties evidence/artifacts, and bumps the worker
 * generation. Serialized against backup/restore.
 */
export const dynamic = "force-dynamic";

const ResetBody = z
  .object({ confirm: z.literal("RESET") })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const gate = mutationGate(request, routePolicy());
  if (gate !== null) {
    return gate;
  }
  const parsed = await parseJsonBody(request, ResetBody);
  if (!parsed.ok) {
    return parsed.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const { paths, candidateDir, migrationsDir } = resolveRoutePaths();
    const result = await runExclusive(() =>
      resetBoardData({
        handle: database.handle,
        paths,
        candidateDir,
        stagingRoot: makeStagingDir("board-reset"),
        openDatabaseAt,
        runMigrations: runMigrationsAt(migrationsDir),
        now: new Date(),
      }),
    );
    // The live file was swapped; the handle below is only closed, never reused.
    return Response.json({
      deletedJobs: result.deletedJobs,
      preResetBackup: result.preResetBackup,
      preservedProfile: result.preservedProfile,
    });
  } catch (error: unknown) {
    if (error instanceof BackupError) {
      return jsonError(500, "reset failed", error.message);
    }
    throw error;
  } finally {
    database.release();
  }
}
