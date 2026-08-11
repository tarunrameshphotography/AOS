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
 * The token lives in sessionStorage, NOT localStorage.
 *
 * WHAT CHANGED AND WHY. It used to be localStorage, which persists until
 * something deletes it — so closing the browser and reopening it hours later
 * resumed the session, and on a shared office PC the next person to open
 * Chrome was signed in as whoever used it last. "Log out" was the only thing
 * that ended a session, and it is the one thing people forget.
 *
 * sessionStorage keeps the property that made localStorage the choice
 * originally — a refresh does NOT return an employee to the login form, which
 * is what makes AOS usable — and drops the one that was never wanted: it is
 * cleared when the browsing context ends. Closing the browser now ends the
 * session in the browser, and the server-side inactivity timeout
 * (`AOS_SESSION_IDLE_MS`, Backend/api-server.ts) ends it on the server whether
 * or not the browser cooperates. Neither control depends on the other, and
 * neither depends on `beforeunload`, which fires unreliably and is not a
 * security mechanism.
 *
 * THE TRADE-OFF, stated rather than hidden: sessionStorage is per-tab, so
 * opening AOS in a second tab asks for a sign-in. That is the correct default
 * for a shared machine holding customer records, and the alternative — a token
 * that outlives the browser — is what this replaces.
 *
 * STILL NOT AN HttpOnly COOKIE. That remains the stronger answer and still
 * needs the API and the app served from one origin in production; it is a
 * deployment change, recorded as the next step rather than pretended away.
 * What has changed is that the token's lifetime no longer depends on it.
 */
function tokenStore(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    // Private browsing, or storage disabled by policy. The session will not
    // survive a refresh, which is a worse experience than a crash rather than
    // a wrong one — and never a silently longer-lived session.
    return null;
  }
}

export function storedToken(): string | null {
  try {
    return tokenStore()?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function storeToken(token: string | null): void {
  try {
    const store = tokenStore();
    if (!store) return;
    if (token === null) store.removeItem(TOKEN_KEY);
    else store.setItem(TOKEN_KEY, token);
    // A token left in localStorage by a build before this change would
    // otherwise sit there forever, unread but not gone. Clearing it here means
    // the first sign-in or sign-out on the new build removes it.
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // As above.
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

/**
 * Upload a document's bytes — the one request this file sends that is not
 * JSON. Raw body, never multipart: AOS never sends more than one file at a
 * time, and the requirement it belongs to is already in the URL. Mirrors the
 * server's own reading of the request (`Backend/api-server.ts`'s
 * `readBinaryBody`).
 */
export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const token = storedToken();
  const headers: Record<string, string> = {
    "X-File-Name": encodeURIComponent(file.name),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (file.type) headers["Content-Type"] = file.type;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method: "POST", headers, body: file });
  } catch {
    throw new ApiError(0, "Cannot reach the AOS server. Check that it is running.");
  }

  if (response.status === 401) {
    storeToken(null);
    for (const listener of unauthorizedListeners) listener();
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      payload && typeof payload === "object" && typeof (payload as any).message === "string"
        ? (payload as any).message
        : "The document could not be uploaded. Please try again.";
    throw new ApiError(response.status, message);
  }

  return (await response.json()) as T;
}

/** Fetch a document's bytes for download/preview, with the same auth and
 * error handling as `api()` — just not JSON in or out. */
export async function apiDownload(
  path: string,
): Promise<{ blob: Blob; fileName: string }> {
  const token = storedToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`/api${path}`, { headers });
  } catch {
    throw new ApiError(0, "Cannot reach the AOS server. Check that it is running.");
  }

  if (response.status === 401) {
    storeToken(null);
    for (const listener of unauthorizedListeners) listener();
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      payload && typeof payload === "object" && typeof (payload as any).message === "string"
        ? (payload as any).message
        : "The document could not be downloaded.";
    throw new ApiError(response.status, message);
  }

  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename="([^"]*)"/.exec(disposition);
  return { blob: await response.blob(), fileName: match?.[1] ?? "document" };
}
