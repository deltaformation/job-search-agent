/** Same-origin API client. Browser fetch sends Origin on POST plus
 * Sec-Fetch-Site, satisfying the mutation gate without extra headers. */

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: unknown;
      reason?: unknown;
    };
    const error = typeof body.error === "string" ? body.error : "request failed";
    const reason = typeof body.reason === "string" ? body.reason : null;
    return reason === null ? error : `${error}: ${reason}`;
  } catch {
    return `request failed (${response.status})`;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: "GET" });
  if (!response.ok) {
    throw new ApiError(response.status, await parseError(response));
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
    throw new ApiError(response.status, await parseError(response));
  }
  return (await response.json()) as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
