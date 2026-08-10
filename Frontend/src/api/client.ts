/**
 * The browser's client for the AOS API.
 *
 * Stage 3B of the Persistence milestone. Until now `Frontend/src/fake/store.ts`
 * WAS the database: an object graph in memory, persisted to one profile's
 * localStorage. This module is what replaces it for the migrated slice —
 * customers, cases, and who is signed in.
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP: the server is the authority. Nothing
 * here decides whether an action is permitted. It sends the request and shows
 * what came back, including the refusal. Anything the UI does with permissions
 * (see `session.can`) decides what to DRAW and never what is allowed — a
 * client-side check is a courtesy to the user, not a control (BR-060).
 *
 * Requests go to `/api/...` on the app's own origin. In development Vite
 * proxies that to the API process on 4321 (see vite.config.ts), which keeps
 * the path identical in dev, under Playwright, and in the office.
 */

/** Where the bearer token lives between page loads. */
const TOKEN_KEY = "aos.token";

/**
 * The token, kept in localStorage rather than memory, because "refresh
 * preserves the session" is a requirement — an employee who reloads a case
 * screen must not land back on the login form.
 *
 * localStorage is readable by any script on this origin, which is worth being
 * plain about: it is the same exposure the prototype's entire database already
 * had, the app ships no third-party scripts, and the alternative (an
 * HttpOnly cookie) needs the API and the app served from one origin in
 * production — a deployment change, recorded as the next step rather than
 * pretended away. The token is short-lived (12 hours) and revocable server-side.
 */
export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing or over quota. The session will not survive a refresh,
    // which is a worse experience than a crash rather than a wrong one.
  }
}

/**
 * A refusal, a validation failure or a network problem — carrying the status
 * so callers can tell "you may not" (403) from "that is not there" (404) from
 * "the office network is down".
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }

  /** The server refused on permissions. Worth distinguishing in the UI: it is
   * the one error where the right response is to explain rather than retry. */
  get isRefusal(): boolean {
    return this.status === 403;
  }
}

/**
 * Someone's session ended underneath them — expired, revoked, or their account
 * deactivated by a manager while they had the app open.
 *
 * `AuthGate` subscribes so it can return to the login screen from anywhere,
 * rather than each screen having to notice a 401 and handle it. A deactivated
 * employee should not be left looking at a page of stale data.
 */
type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  /** Suppress the global sign-out on a 401. Only the login call uses this: a
   * wrong password is a 401 that must not look like an expired session. */
  readonly anonymous?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = storedToken();
  const headers: Record<string, string> = {};
  if (token && !options.anonymous) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    // The API process is down or the network dropped. Said plainly, because
    // "Failed to fetch" tells an employee in Coimbatore nothing actionable.
    throw new ApiError(0, "Cannot reach the AOS server. Check that it is running.");
  }

  if (response.status === 401 && !options.anonymous) {
    storeToken(null);
    for (const listener of unauthorizedListeners) listener();
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && typeof (payload as any).message === "string"
        ? (payload as any).message
        : "Something went wrong. Please try again.";
    throw new ApiError(response.status, message);
  }

  return payload as T;
}
