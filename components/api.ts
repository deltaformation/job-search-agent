/** Same-origin API client. Browser fetch sends Origin on POST plus
 * Sec-Fetch-Site, satisfying the mutation gate without extra headers. */

export class ApiError extends Error {
  readonly status: number;
  /** Parsed error payload when the server sent JSON (e.g. conflict versions). */
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

async function parseError(response: Response): Promise<{ message: string; payload: unknown }> {
  try {
    const body = (await response.json()) as {
      error?: unknown;
      reason?: unknown;
    };
    const error = typeof body.error === "string" ? body.error : "request failed";
    const reason = typeof body.reason === "string" ? body.reason : null;
    return { message: reason === null ? error : `${error}: ${reason}`, payload: body };
  } catch {
    return { message: `request failed (${response.status})`, payload: null };
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: "GET" });
  if (!response.ok) {
    const parsed = await parseError(response);
    throw new ApiError(response.status, parsed.message, parsed.payload);
  }
  return (await response.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const parsed = await parseError(response);
    throw new ApiError(response.status, parsed.message, parsed.payload);
  }
  return (await response.json()) as T;
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const parsed = await parseError(response);
    throw new ApiError(response.status, parsed.message, parsed.payload);
  }
  return (await response.json()) as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
