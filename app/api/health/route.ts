import { join } from "node:path";
import { discoverMigrationFiles } from "../../../src/db/migrate";
import {
  dataRootStatus,
  resolveDataRoot,
} from "../../../src/security/data-root";

/**
 * Local health probe. Filesystem-only (never opens the database, never runs
 * at build time): reports data-root inventory plus the checked-in migration
 * list so a degraded install is diagnosable from one response.
 */
export const dynamic = "force-dynamic";

interface HealthBody {
  status: "ok" | "degraded";
  dataRoot: ReturnType<typeof dataRootStatus>;
  migrations: { directory: string; files: string[] };
}

export async function GET(): Promise<Response> {
  const paths = resolveDataRoot(process.env);
  const dataRoot = dataRootStatus(paths);
  const directory = join(process.cwd(), "drizzle");
  let files: string[] = [];
  try {
    files = discoverMigrationFiles(directory).map((file) => file.filename);
  } catch {
    files = [];
  }
  const body: HealthBody = {
    status:
      dataRoot.databaseExists && dataRoot.evidenceExists && files.length > 0
        ? "ok"
        : "degraded",
    dataRoot,
    migrations: { directory, files },
  };
  return Response.json(body, { status: body.status === "ok" ? 200 : 503 });
}
