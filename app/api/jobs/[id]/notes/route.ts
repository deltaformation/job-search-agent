import { AddNoteInput, addNote } from "../../../../../src/server/workflow";
import {
  mutationGate,
  openRequestDatabase,
  parseJsonBody,
} from "../../../_lib/request";
import { commandFailureResponse, jobIdGate } from "../../_lib/failures";

/** Append one user note. Notes never move the card or bump its version. */
export const dynamic = "force-dynamic";

const NoteBody = AddNoteInput.omit({ jobId: true });

interface NotesRouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: NotesRouteContext,
): Promise<Response> {
  const gate = mutationGate(request);
  if (gate !== null) {
    return gate;
  }
  const { id } = await context.params;
  const idGate = jobIdGate(id);
  if (idGate !== null) {
    return idGate;
  }
  const body = await parseJsonBody(request, NoteBody);
  if (!body.ok) {
    return body.response;
  }
  const database = openRequestDatabase();
  if (!database.ok) {
    return database.response;
  }
  try {
    const noted = addNote(database.handle, { ...body.value, jobId: id });
    if (!noted.ok) {
      return commandFailureResponse(noted);
    }
    return Response.json(noted);
  } finally {
    database.release();
  }
}
