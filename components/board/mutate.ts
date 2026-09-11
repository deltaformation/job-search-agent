import { ApiError, apiPost } from "../api";

/**
 * POST a board mutation with one conflict retry. A 409 means nothing was
 * written, so replaying once with the server's fresh row version is safe;
 * anything else (including a second 409) throws for the caller to report.
 */
export async function postJobMutation<T>(
  path: string,
  body: Record<string, unknown> & { observedRowVersion: number },
): Promise<T> {
  try {
    return await apiPost<T>(path, body);
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 409) {
      const payload = (error.payload ?? {}) as { currentRowVersion?: unknown };
      if (typeof payload.currentRowVersion === "number") {
        return apiPost<T>(path, { ...body, observedRowVersion: payload.currentRowVersion });
      }
    }
    throw error;
  }
}
