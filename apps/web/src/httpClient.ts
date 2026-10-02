/**
 * The one HTTP client both apps use.
 *
 * Two things in here are load-bearing rather than incidental.
 *
 * Every call sends `credentials: 'include'`. The session lives in an httpOnly
 * cookie, so without it the server sees an anonymous visitor and every order in
 * the account vanishes - which reads as a bug in the page rather than a missing
 * header. Having this in one place is what makes that true of a *new* endpoint by
 * default instead of by remembering.
 *
 * Errors are read from the API's own envelope rather than invented per call site,
 * so a failed call carries the server's code, message and field issues. A body
 * that is not JSON - a proxy timeout, say - still has to surface as something a
 * person can read, so the status line is the floor rather than a thrown parse.
 *
 * There was one copy of this per app. They had already drifted: the staff client
 * grew field issues for its forms and the shop one did not, so the two surfaces
 * reported the same failure differently. Drift in a credential header is the kind
 * of thing that only shows up in production, which is the argument for having one.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: readonly string[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorEnvelope {
  readonly error?: string;
  readonly message?: string;
  readonly issues?: readonly string[];
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    throw await toApiError(response);
  }
  return (await response.json()) as T;
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

async function toApiError(response: Response): Promise<ApiError> {
  let envelope: ErrorEnvelope = {};
  try {
    envelope = (await response.json()) as ErrorEnvelope;
  } catch {
    // A non-JSON error body (a proxy timeout, say) still has to surface as
    // something the UI can render, so fall back to the status line.
  }
  return new ApiError(
    response.status,
    envelope.error ?? 'http_error',
    envelope.message ?? `request failed with status ${response.status}`,
    envelope.issues ?? [],
  );
}