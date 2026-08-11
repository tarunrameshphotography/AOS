#!/usr/bin/env node
/**
 * The AOS application API.
 *
 * Stage 2 of the Persistence milestone: ONE vertical slice — customers and
 * cases — proved end to end against PostgreSQL, so the architecture is
 * demonstrated before the other ~85 store functions are ported to it.
 *
 * Stage 3A adds the second surface: user administration and per-user
 * permission overrides (`Backend/users.ts`). It is here rather than in a later
 * stage because the frontend cutover in 3B will be run BY these accounts —
 * creating the real employees, and being able to enforce an exception granted
 * to one of them, has to be true of the server before anyone depends on it.
 *
 * WHAT CHANGED CONCEPTUALLY: the browser is no longer the database. It was
 * `Frontend/src/fake/store.ts`, an in-memory object graph persisted to one
 * profile's localStorage, which meant a Telecaller's cases existed only on the
 * Telecaller's PC and every permission check was advice a client could skip.
 * The authority is now here, and the browser is a client of it.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *   - A generic CRUD surface. Routes are named after operations the domain
 *     already has (`case.create`, `person.update`), because a generic
 *     `PATCH /table/:id` would have no place to enforce the case-ownership
 *     rule that is the entire point of the exercise.
 *   - Document bytes. They stay on disk via `storage-server.mjs`; the database
 *     holds only the storage path. Untouched by this milestone.
 *   - Everything outside the slice: requirements, verification, submissions.
 *     Stage 2 is a proof, not the migration. The event log was on this list
 *     too: administrative actions came off it in 3A, and customer and case
 *     writes came off it in Stage 3C-0 (`Backend/events.ts`). Every mutation
 *     this API accepts now appends to `event` in its own transaction.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

import { verifyPassword } from "@domain/auth/password.js";
import type { Role } from "@domain/permissions/index.js";

import { pool, withActor } from "./db.js";
import { can, canActOnCase, refusal, widestScopeFor, type Actor } from "./authorize.js";
import { ApiError, DATABASE_UNAVAILABLE_MESSAGE, isDatabaseUnavailable } from "./http.js";
import {
  casesForPerson,
  createCase,
  listCases,
  markLost,
  moveStage,
  readCase,
  reopen,
  assignOwner,
  setHold,
  updateCase,
} from "./cases.js";
import {
  createCustomer,
  getCustomer,
  listCustomers,
  setCustomerIdentifiers,
  updateCustomer,
} from "./customers.js";
import { readReference, search } from "./reference.js";
import {
  listDocumentTypes,
  updateDocumentType,
  setDocumentTypeActive,
  listRejectionReasons,
  updateRejectionReason,
  setRejectionReasonActive,
  listDocumentRequirementRules,
  updateDocumentRequirementRule,
  setDocumentRequirementRuleActive,
  listThresholds,
  updateThreshold,
} from "./master-data.js";
import {
  changeOwnPassword,
  createUser,
  getUser,
  getUserPermissions,
  listUsers,
  loadOverrides,
  resetUserPassword,
  revokeOverride,
  setOverride,
  setUserActive,
  setUserRoles,
} from "./users.js";
import { listCaseRequirements, uploadDocument, decideDocument, downloadDocument } from "./documents.js";
import { listLenders } from "./lenders.js";
import {
  createSubmission,
  listPackages,
  listSubmissions,
  preparePackage,
  retryPackage,
  sendableDocuments,
  sendPackage,
} from "./submissions.js";

const PORT = Number(process.env.AOS_API_PORT ?? 4321);

/**
 * Which network interface to accept connections on.
 *
 * DEFAULTS TO LOOPBACK, AND THAT DEFAULT IS THE SAFE ONE. A developer's
 * checkout, a test run and an employee's PC all want 127.0.0.1: nothing
 * outside the machine should be able to reach an AOS API that is not the
 * office's.
 *
 * THE OFFICE SERVER SETS `AOS_API_HOST=0.0.0.0` (Docs/Installation.md). Until
 * Stage 4 there was no way to do that at all — this process bound 127.0.0.1
 * unconditionally, which meant the topology every document described (one
 * server PC, every other PC pointing a browser at it) was not achievable with
 * the code as written. Employees could only have used AOS by running the whole
 * backend on their own machines, which `Docs/Deployment Topology.md` forbids
 * precisely because it silently creates a second, disconnected document store.
 *
 * THE API IS THE ONLY PROCESS THAT MAY LISTEN ON THE LAN. `storage-server.mjs`
 * and `mail-server.mjs` stay on loopback and refuse to do otherwise: they have
 * no authentication of their own, so the API — which checks `document.read`
 * and `submission.create` before a byte moves — is the only safe front door.
 */
const HOST = process.env.AOS_API_HOST?.trim() || "127.0.0.1";

/** A workday. Long enough that nobody is re-authenticating mid-case, short
 * enough that a browser left logged in overnight in a shared office does not
 * stay open indefinitely. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Raw bytes for a document upload — never JSON, and capped far higher than
 * an ordinary form body. Mirrors `storage-server.mjs`'s `readBody`: a
 * multipart parser buys nothing here, since AOS never sends more than one
 * file per request and the requirement it belongs to is already in the URL. */
async function readBinaryBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, "That file is larger than AOS currently accepts (25 MB).");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** A route handler that has already written its own response — a document
 * download, which is bytes, not JSON. `route()` returns this instead of a
 * value, and the dispatcher below skips the `json()` envelope entirely. */
class RawResponse {
  constructor(
    readonly bytes: Uint8Array,
    readonly contentType: string,
    readonly fileName: string,
  ) {}
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // This API carries form fields, never file bytes — those go to the storage
    // backend. A megabyte is already far more than any case field needs.
    if (size > 1_000_000) throw new HttpError(413, "Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
}

/**
 * Which browser origins may read this API's responses.
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS WRONG (Stage 4 Item 3). It reflected
 * whatever arrived: `res.setHeader("Access-Control-Allow-Origin",
 * req.headers.origin ?? "*")`. Every origin on the internet was therefore
 * allowed to read every response this server produced.
 *
 * It was not session-riding — `Access-Control-Allow-Credentials` is not set and
 * the token lives in localStorage, which no other origin can read, so a
 * malicious page could not act AS a signed-in employee. What it could do is
 * use an employee's browser as a bridge onto the office LAN: an unauthenticated
 * `POST /api/auth/login` per page view, with the response readable, is
 * credential-stuffing originating from inside the network from a machine that
 * is supposed to be there. `/api/health/detail` was readable the same way. The
 * office server binds 0.0.0.0, so "you have to be on the LAN" was the only
 * control, and this handed that out to any web page an employee opened.
 *
 * Now: an allowlist. AOS is served to employees from ONE address —
 * `http://<server LAN IP>:<AOS_WEB_PORT>` — and developed against Vite on
 * 5173. An origin not on the list gets no `Access-Control-Allow-Origin` header
 * at all, which is the correct refusal: the browser blocks the read, and no
 * header is a clearer statement than an echoed one.
 *
 * AOS_ALLOWED_ORIGINS (comma-separated) exists for the installation that
 * fronts AOS with a reverse proxy or a hostname, since this process cannot
 * guess either. Set it and it replaces the derived list entirely.
 *
 * NONE OF THIS IS THE AUTHORIZATION BOUNDARY. CORS is enforced by the browser
 * and by nothing else — curl ignores it completely. Every route below still
 * checks the token and the permission, and would still refuse if this function
 * were deleted. This narrows what a *page in an employee's browser* can do,
 * which is a real and separate exposure.
 */
function allowedOrigins(): readonly string[] {
  const configured = process.env.AOS_ALLOWED_ORIGINS?.trim();
  if (configured) {
    return configured
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter((origin) => origin.length > 0);
  }

  const webPort = Number(process.env.AOS_WEB_PORT ?? 4300);
  const origins = [
    // The bundled web server, however an employee reaches it. The LAN-IP form
    // cannot be derived here — the office sets AOS_ALLOWED_ORIGINS for that,
    // and does not need to while the web server proxies /api on its own origin,
    // which makes the request same-origin and sends no Origin header at all.
    `http://localhost:${webPort}`,
    `http://127.0.0.1:${webPort}`,
    // Vite in development, and Playwright driving it.
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ];
  return origins;
}

const ALLOWED_ORIGINS = allowedOrigins();

/** Exported for the security test, which asserts a foreign origin is refused
 * without needing to guess the derivation above. */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return false;
  return ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ""));
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  // Always varies, even when the header is withheld: a cache must not serve
  // one origin the allow-header computed for another.
  res.setHeader("Vary", "Origin");
  if (!isOriginAllowed(origin)) return;

  res.setHeader("Access-Control-Allow-Origin", origin!);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-File-Name");
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Resolve a bearer token to the employee making the request.
 *
 * Roles are read fresh on every request rather than baked into the token. A
 * manager who revokes a role expects it to take effect now, not whenever that
 * employee next logs in — and an inactive user is refused here, which is what
 * makes deactivation bite immediately.
 */
async function loadActor(client: pg.PoolClient, token: string | null): Promise<Actor | null> {
  if (!token) return null;

  const { rows } = await client.query(
    `select u.id, u.auth_identity_id, u.is_active, s.expires_at, s.revoked_at
       from api_session s
       join app_user u on u.id = s.user_id
      where s.token_hash = $1`,
    [hashToken(token)],
  );
  const session = rows[0];
  if (!session) return null;
  if (session.revoked_at !== null) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  if (!session.is_active) return null;

  const roleRows = await client.query(
    `select role from user_role where user_id = $1 and revoked_at is null`,
    [session.id],
  );

  await client.query(
    `update api_session set last_seen_at = now() where token_hash = $1`,
    [hashToken(token)],
  );

  return {
    userId: session.id,
    authIdentityId: session.auth_identity_id,
    roles: roleRows.rows.map((r: { role: string }) => r.role as Role),
    // Live overrides, read fresh alongside the roles — a withdrawn exception
    // stops applying on the next request, not at the next login (Stage 3A).
    overrides: await loadOverrides(client, session.id),
  };
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function requireActor(actor: Actor | null): Actor {
  if (!actor) throw new HttpError(401, "Sign in to continue.");
  return actor;
}

function requirePermission(
  actor: Actor,
  permission: string,
  scope: Parameters<typeof can>[2] = "own",
): void {
  if (!can(actor, permission, scope)) throw new HttpError(403, refusal(permission));
}

// ---------------------------------------------------------------------------
// Handlers — authentication
// ---------------------------------------------------------------------------

/**
 * Login throttling.
 *
 * THE HOLE THIS CLOSES (Stage 4 Item 3). `POST /api/auth/login` accepted
 * unlimited attempts. The only brake was PBKDF2 at 100,000 iterations, which
 * costs an attacker ~50-100ms per guess — slow for a human, an afternoon for a
 * script. AOS enforces an eight-character minimum (MIN_PASSWORD_LENGTH in
 * users.ts), the office server binds 0.0.0.0, and the accounts on the other
 * side of that form hold every customer's documents.
 *
 * It is also, in the other direction, the one unauthenticated route that does
 * real work: 100,000 hash iterations per request, on the single-process API
 * that every employee shares. A few hundred concurrent attempts is a denial of
 * service with no credentials at all.
 *
 * IN PROCESS, NOT IN THE DATABASE, and that is a deliberate limit rather than
 * an oversight. A table would survive a restart and would be shared if AOS ever
 * ran more than one API process; it would also mean an unauthenticated request
 * can make the office database write, which is the thing being defended
 * against. AOS runs exactly one API process on one PC (Docs/Deployment
 * Topology.md), so a Map is honest about the deployment. What it costs: a
 * restart clears the counters. Twelve failed attempts then a restart is not a
 * plausible attack, and if AOS ever grows a second process this comment is the
 * thing to come back to.
 *
 * Keyed on username AND client address together, so one employee mistyping
 * their password on their own PC cannot lock a colleague out of the same
 * account from theirs — lockout by username alone is itself a denial of
 * service, and a trivially cheap one.
 */
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
/** How long a quiet period wipes the count. Longer than the lockout, so an
 * attacker cannot reset the counter by pausing for less than they lose. */
const LOGIN_WINDOW_MS = 30 * 60 * 1000;

const loginAttempts = new Map<string, { failures: number; first: number; lockedUntil: number }>();

function throttleKey(username: string, req: IncomingMessage): string {
  // The socket address, not X-Forwarded-For: nothing in the AOS topology sets
  // that header, so trusting it would let a caller choose their own bucket.
  // Length-prefixed rather than delimited: no separator character can be
  // smuggled in through a username, and unlike the NUL byte that did the
  // same job a moment ago, it leaves this file as text that git can diff.
  const who = username.toLowerCase();
  return `${who.length}:${who}:${req.socket.remoteAddress ?? "unknown"}`;
}

/** Throws 429 when this username/address pair is locked out. Called before the
 * password is hashed, so a locked-out caller costs nothing to refuse. */
function assertNotThrottled(key: string): void {
  const entry = loginAttempts.get(key);
  if (!entry) return;

  const now = Date.now();
  if (entry.lockedUntil > now) {
    const minutes = Math.max(1, Math.ceil((entry.lockedUntil - now) / 60_000));
    throw new HttpError(
      429,
      `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, ` +
        `or ask a manager to reset your password.`,
    );
  }
  if (now - entry.first > LOGIN_WINDOW_MS) loginAttempts.delete(key);
}

function recordLoginFailure(key: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { failures: 1, first: now, lockedUntil: 0 });
    return;
  }
  entry.failures += 1;
  if (entry.failures >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
}

/** A successful sign-in clears the count for that username and address — the
 * person has proven they are who the counter was suspicious of. */
function clearLoginFailures(key: string): void {
  loginAttempts.delete(key);
}

/** Test seam. The suite drives real HTTP against a real server and would
 * otherwise leak a lockout from one test into the next. */
export function resetLoginThrottle(): void {
  loginAttempts.clear();
}

async function login(client: pg.PoolClient, req: IncomingMessage, body: Record<string, unknown>) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const key = throttleKey(username, req);
  assertNotThrottled(key);

  const { rows } = await client.query(
    `select id, password_hash, is_active from app_user where lower(username) = lower($1)`,
    [username],
  );
  const user = rows[0];

  // One message for "no such user", "wrong password" and "deactivated". The
  // login form must not become a way to enumerate who works here, or to learn
  // that a departed employee's account still exists.
  const rejection = new HttpError(401, "Incorrect username or password.");
  const refuse = (): never => {
    recordLoginFailure(key);
    throw rejection;
  };
  if (!user || !user.password_hash) refuse();
  if (!(await verifyPassword(password, user.password_hash))) refuse();
  // A deactivated employee counts as a failure too. Otherwise the throttle
  // would be a way to tell "this account is disabled" from "this password is
  // wrong" — the one distinction the identical rejection text above exists to
  // hide.
  if (!user.is_active) refuse();

  clearLoginFailures(key);
  const token = randomBytes(32).toString("base64url");
  await client.query(
    `insert into api_session (user_id, token_hash, expires_at) values ($1, $2, $3)`,
    [user.id, hashToken(token), new Date(Date.now() + SESSION_TTL_MS)],
  );
  await client.query(`update app_user set last_login_at = now() where id = $1`, [user.id]);

  return { token, user: await describeUser(client, user.id) };
}

async function describeUser(client: pg.PoolClient, userId: string) {
  const { rows } = await client.query(
    // `r.role::text` and an explicitly typed empty array: without the casts
    // Postgres infers an untyped literal and node-postgres hands back the
    // array's text form (`'{telecaller}'`) instead of a JS array.
    `select u.id, u.username, p.full_name,
            coalesce(array_agg(r.role::text) filter (where r.revoked_at is null),
                     '{}'::text[]) as roles
       from app_user u
       join person p on p.id = u.person_id
       left join user_role r on r.user_id = u.id
      where u.id = $1
      group by u.id, u.username, p.full_name`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, "No such user.");
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    roles: row.roles,
    /**
     * The signed-in employee's OWN live overrides (Stage 3B).
     *
     * The browser needs these to answer "should this button be shown", which
     * it answers by calling `hasPermissionWithOverrides` — the same function
     * the server enforces with. Without them the UI would compute permissions
     * from roles alone and disagree with the server for any employee holding
     * an exception: a button that produces a 403, or a button that is hidden
     * from someone who was explicitly granted the thing.
     *
     * This is their own data and nobody else's. Reading somebody ELSE's
     * overrides needs `permission.override` and goes through
     * `/api/users/:id/permissions`.
     *
     * NONE OF THIS IS A SECURITY BOUNDARY. It decides what is drawn, never
     * what is allowed — every request is re-checked server-side against the
     * same overrides, read fresh, so a tampered client gets a refusal rather
     * than an action (BR-060).
     */
    overrides: await loadOverrides(client, userId),
  };
}

// ---------------------------------------------------------------------------
// Health probes
// ---------------------------------------------------------------------------

const STORAGE_URL = (process.env.AOS_STORAGE_SERVER_URL ?? "http://127.0.0.1:4319").replace(/\/$/, "");
const MAIL_URL = (process.env.AOS_MAIL_SERVER_URL ?? "http://127.0.0.1:4320").replace(/\/$/, "");

/** "up" or "down", with a short timeout. A health check that hangs because
 * one backend is wedged is worse than one that reports the wedge. */
async function probe(url: string): Promise<"up" | "down"> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok ? "up" : "down";
  } catch {
    return "down";
  }
}

/**
 * Mail is three states, not two, because "running" and "able to send" are
 * different questions here and only the second one matters to an employee
 * about to submit a package. `mail-server.mjs`'s own `/health` already
 * distinguishes them: an `unconfigured` provider is up and refusing.
 */
async function probeMail(): Promise<"up" | "unconfigured" | "down"> {
  try {
    const response = await fetch(`${MAIL_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return "down";
    const body = (await response.json()) as { configured?: boolean };
    return body.configured === true ? "up" : "unconfigured";
  } catch {
    return "down";
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const UUID = "[0-9a-fA-F-]{36}";

async function route(
  client: pg.PoolClient,
  req: IncomingMessage,
  method: string,
  path: string,
  body: Record<string, unknown>,
  actor: Actor | null,
  rawBody: Buffer | null,
): Promise<unknown> {
  if (method === "GET" && path === "/api/health") {
    await client.query("select 1");
    return { ok: true };
  }

  /**
   * The operator's view: is each part of AOS actually working?
   *
   * Unauthenticated on purpose — a monitoring check that needs a login is a
   * monitoring check that stops working the day the password changes, and
   * `Scripts/aos-status.ps1` runs before anyone has signed in. It therefore
   * says only whether each component answers, never a version, a path, a
   * connection string or a count. "Postgres is up" is not information an
   * attacker on the office LAN gains anything from; the reason it is worth
   * publishing is that "which of the four processes is down" is the first
   * question anyone debugging this system asks.
   *
   * Reaching the database is already proven by having got this far — every
   * request runs inside a transaction (`withActor`), so a database that was
   * down would have failed before routing.
   */
  if (method === "GET" && path === "/api/health/detail") {
    return {
      ok: true,
      database: "up",
      storage: await probe(`${STORAGE_URL}/health`),
      mail: await probeMail(),
    };
  }

  if (method === "POST" && path === "/api/auth/login") return await login(client, req, body);

  if (method === "POST" && path === "/api/auth/logout") {
    const token = bearerToken(req);
    if (token) {
      await client.query(
        `update api_session set revoked_at = now()
          where token_hash = $1 and revoked_at is null`,
        [hashToken(token)],
      );
    }
    return { ok: true };
  }

  if (method === "GET" && path === "/api/auth/me") {
    return await describeUser(client, requireActor(actor).userId);
  }

  if (method === "POST" && path === "/api/auth/password") {
    const token = bearerToken(req);
    return await changeOwnPassword(
      client,
      requireActor(actor),
      token ? hashToken(token) : null,
      body,
    );
  }

  // ── User administration ───────────────────────────────────────────────────
  // Named after the operations rather than the table, for the same reason the
  // case routes are: "replace this user's roles" and "deactivate this user"
  // carry different permissions and different rules, and a generic
  // `PATCH /api/users/:id` would have nowhere to put that distinction.

  if (method === "GET" && path === "/api/users") {
    return await listUsers(client, requireActor(actor));
  }
  if (method === "POST" && path === "/api/users") {
    return await createUser(client, requireActor(actor), body);
  }

  const userMatch = new RegExp(`^/api/users/(${UUID})$`).exec(path);
  if (userMatch && method === "GET") {
    return await getUser(client, requireActor(actor), userMatch[1]!);
  }

  const rolesMatch = new RegExp(`^/api/users/(${UUID})/roles$`).exec(path);
  if (rolesMatch && method === "PUT") {
    return await setUserRoles(client, requireActor(actor), rolesMatch[1]!, body);
  }

  const activeMatch = new RegExp(`^/api/users/(${UUID})/active$`).exec(path);
  if (activeMatch && method === "PUT") {
    return await setUserActive(client, requireActor(actor), activeMatch[1]!, body);
  }

  const passwordMatch = new RegExp(`^/api/users/(${UUID})/password$`).exec(path);
  if (passwordMatch && method === "PUT") {
    return await resetUserPassword(client, requireActor(actor), passwordMatch[1]!, body);
  }

  const permissionsMatch = new RegExp(`^/api/users/(${UUID})/permissions$`).exec(path);
  if (permissionsMatch && method === "GET") {
    return await getUserPermissions(client, requireActor(actor), permissionsMatch[1]!);
  }

  const overridesMatch = new RegExp(`^/api/users/(${UUID})/overrides$`).exec(path);
  if (overridesMatch && method === "POST") {
    return await setOverride(client, requireActor(actor), overridesMatch[1]!, body);
  }

  const overrideMatch = new RegExp(`^/api/users/(${UUID})/overrides/(${UUID})$`).exec(path);
  if (overrideMatch && method === "DELETE") {
    return await revokeOverride(client, requireActor(actor), overrideMatch[1]!, overrideMatch[2]!);
  }

  // ── Reference data and search ─────────────────────────────────────────────

  if (method === "GET" && path === "/api/reference") {
    return await readReference(client, requireActor(actor));
  }
  if (method === "GET" && path === "/api/search") {
    const query = new URL(req.url ?? "/", "http://localhost").searchParams.get("q") ?? "";
    return await search(client, requireActor(actor), query);
  }

  // ── Master data (Stage 4 Item 4) ─────────────────────────────────────────
  //
  // Document types, rejection reasons, document requirement rules and
  // operational thresholds — the four categories moved onto a real,
  // permission-gated write path this stage. Products and lenders stay
  // read-only (`/api/reference`, `/api/lenders` above); see Backend/master-data.ts.

  if (method === "GET" && path === "/api/master-data/document-types") {
    return await listDocumentTypes(client, requireActor(actor));
  }
  const documentTypeMatch = new RegExp(`^/api/master-data/document-types/(${UUID})$`).exec(path);
  if (documentTypeMatch && method === "PUT") {
    return await updateDocumentType(client, requireActor(actor), documentTypeMatch[1]!, body);
  }
  const documentTypeActiveMatch = new RegExp(`^/api/master-data/document-types/(${UUID})/active$`).exec(path);
  if (documentTypeActiveMatch && method === "PUT") {
    return await setDocumentTypeActive(client, requireActor(actor), documentTypeActiveMatch[1]!, body);
  }

  if (method === "GET" && path === "/api/master-data/rejection-reasons") {
    return await listRejectionReasons(client, requireActor(actor));
  }
  const rejectionReasonMatch = new RegExp(`^/api/master-data/rejection-reasons/(${UUID})$`).exec(path);
  if (rejectionReasonMatch && method === "PUT") {
    return await updateRejectionReason(client, requireActor(actor), rejectionReasonMatch[1]!, body);
  }
  const rejectionReasonActiveMatch = new RegExp(`^/api/master-data/rejection-reasons/(${UUID})/active$`).exec(
    path,
  );
  if (rejectionReasonActiveMatch && method === "PUT") {
    return await setRejectionReasonActive(
      client,
      requireActor(actor),
      rejectionReasonActiveMatch[1]!,
      body,
    );
  }

  if (method === "GET" && path === "/api/master-data/document-rules") {
    return await listDocumentRequirementRules(client, requireActor(actor));
  }
  const documentRuleMatch = new RegExp(`^/api/master-data/document-rules/(${UUID})$`).exec(path);
  if (documentRuleMatch && method === "PUT") {
    return await updateDocumentRequirementRule(client, requireActor(actor), documentRuleMatch[1]!, body);
  }
  const documentRuleActiveMatch = new RegExp(`^/api/master-data/document-rules/(${UUID})/active$`).exec(
    path,
  );
  if (documentRuleActiveMatch && method === "PUT") {
    return await setDocumentRequirementRuleActive(
      client,
      requireActor(actor),
      documentRuleActiveMatch[1]!,
      body,
    );
  }

  if (method === "GET" && path === "/api/master-data/thresholds") {
    return await listThresholds(client, requireActor(actor));
  }
  const thresholdMatch = /^\/api\/master-data\/thresholds\/([\w.]+)$/.exec(path);
  if (thresholdMatch && method === "PUT") {
    return await updateThreshold(client, requireActor(actor), decodeURIComponent(thresholdMatch[1]!), body);
  }

  // ── Customers ─────────────────────────────────────────────────────────────

  if (method === "GET" && path === "/api/customers") {
    const query = new URL(req.url ?? "/", "http://localhost").searchParams.get("q");
    return await listCustomers(client, requireActor(actor), query);
  }
  if (method === "POST" && path === "/api/customers") {
    return await createCustomer(client, requireActor(actor), body);
  }
  const customerMatch = new RegExp(`^/api/customers/(${UUID})$`).exec(path);
  if (customerMatch) {
    const id = customerMatch[1]!;
    if (method === "GET") return await getCustomer(client, requireActor(actor), id);
    if (method === "PATCH") return await updateCustomer(client, requireActor(actor), id, body);
  }

  const identifiersMatch = new RegExp(`^/api/customers/(${UUID})/identifiers$`).exec(path);
  if (identifiersMatch && method === "PUT") {
    return await setCustomerIdentifiers(client, requireActor(actor), identifiersMatch[1]!, body);
  }

  const personCasesMatch = new RegExp(`^/api/customers/(${UUID})/cases$`).exec(path);
  if (personCasesMatch && method === "GET") {
    return await casesForPerson(client, requireActor(actor), personCasesMatch[1]!);
  }

  // ── Cases ─────────────────────────────────────────────────────────────────
  //
  // The verbs are separate routes, not flags on a PATCH. `case.hold`,
  // `case.mark_lost`, `case.reopen` and `case.assign` are four different
  // permissions, held at different scopes by different roles; folding them
  // into one field patch would make `case.update` silently grant all of them.

  if (method === "GET" && path === "/api/cases") {
    return await listCases(client, requireActor(actor));
  }
  if (method === "POST" && path === "/api/cases") {
    return await createCase(client, requireActor(actor), body);
  }
  const caseMatch = new RegExp(`^/api/cases/(${UUID})$`).exec(path);
  if (caseMatch) {
    const id = caseMatch[1]!;
    if (method === "GET") return await readCase(client, requireActor(actor), id);
    if (method === "PATCH") return await updateCase(client, requireActor(actor), id, body);
  }

  const stageMatch = new RegExp(`^/api/cases/(${UUID})/stage$`).exec(path);
  if (stageMatch && method === "PUT") {
    return await moveStage(client, requireActor(actor), stageMatch[1]!, body);
  }

  const holdMatch = new RegExp(`^/api/cases/(${UUID})/hold$`).exec(path);
  if (holdMatch && method === "PUT") {
    return await setHold(client, requireActor(actor), holdMatch[1]!, body);
  }

  const lostMatch = new RegExp(`^/api/cases/(${UUID})/lost$`).exec(path);
  if (lostMatch && method === "PUT") {
    return await markLost(client, requireActor(actor), lostMatch[1]!, body);
  }

  const reopenMatch = new RegExp(`^/api/cases/(${UUID})/reopen$`).exec(path);
  if (reopenMatch && method === "POST") {
    return await reopen(client, requireActor(actor), reopenMatch[1]!);
  }

  const ownerMatch = new RegExp(`^/api/cases/(${UUID})/owner$`).exec(path);
  if (ownerMatch && method === "PUT") {
    return await assignOwner(client, requireActor(actor), ownerMatch[1]!, body);
  }

  // ── Requirements and documents ────────────────────────────────────────────
  //
  // Stage 3C. `document.upload` and `document.verify` are separate
  // permissions from `case.update` (Docs/Permission Matrix.md) — a Telecaller
  // may collect documents on their own case without being able to verify
  // them, and a Login Executive verifies across every case they can see.

  const requirementsMatch = new RegExp(`^/api/cases/(${UUID})/requirements$`).exec(path);
  if (requirementsMatch && method === "GET") {
    return await listCaseRequirements(client, requireActor(actor), requirementsMatch[1]!);
  }

  const uploadMatch = new RegExp(`^/api/cases/(${UUID})/requirements/(${UUID})/documents$`).exec(path);
  if (uploadMatch && method === "POST") {
    if (!rawBody) throw new HttpError(400, "A file is required.");
    const fileName = decodeURIComponent(req.headers["x-file-name"] as string | undefined ?? "document");
    const contentType = req.headers["content-type"];
    return await uploadDocument(client, requireActor(actor), uploadMatch[1]!, uploadMatch[2]!, {
      bytes: rawBody,
      fileName,
      ...(typeof contentType === "string" && contentType.length > 0 ? { contentType } : {}),
    });
  }

  const verifyMatch = new RegExp(`^/api/cases/(${UUID})/requirements/(${UUID})/decision$`).exec(path);
  if (verifyMatch && method === "PUT") {
    return await decideDocument(client, requireActor(actor), verifyMatch[1]!, verifyMatch[2]!, body);
  }

  const downloadMatch = new RegExp(`^/api/documents/(${UUID})/download$`).exec(path);
  if (downloadMatch && method === "GET") {
    const result = await downloadDocument(client, requireActor(actor), downloadMatch[1]!);
    return new RawResponse(result.bytes, result.contentType, result.fileName);
  }

  // ── Lenders ───────────────────────────────────────────────────────────────

  if (method === "GET" && path === "/api/lenders") {
    return await listLenders(client, requireActor(actor));
  }

  // ── Bank submissions ─────────────────────────────────────────────────────
  //
  // Stage 3D. The verbs mirror documents.ts's shape: a submission is created
  // separately from sending its documents, and sending is itself two steps —
  // `prepare` plans and writes nothing, `send`/`retry` write and dispatch —
  // so the review screen and the sender walk the same object (package.ts).

  const submissionsMatch = new RegExp(`^/api/cases/(${UUID})/submissions$`).exec(path);
  if (submissionsMatch && method === "GET") {
    return await listSubmissions(client, requireActor(actor), submissionsMatch[1]!);
  }
  if (submissionsMatch && method === "POST") {
    return await createSubmission(client, requireActor(actor), submissionsMatch[1]!, body);
  }

  const sendableMatch = new RegExp(`^/api/cases/(${UUID})/submissions/(${UUID})/sendable-documents$`).exec(path);
  if (sendableMatch && method === "GET") {
    return await sendableDocuments(client, requireActor(actor), sendableMatch[1]!, sendableMatch[2]!);
  }

  const prepareMatch = new RegExp(`^/api/cases/(${UUID})/submissions/(${UUID})/package/prepare$`).exec(path);
  if (prepareMatch && method === "POST") {
    return await preparePackage(client, requireActor(actor), prepareMatch[1]!, prepareMatch[2]!, body);
  }

  const sendMatch = new RegExp(`^/api/cases/(${UUID})/submissions/(${UUID})/package/send$`).exec(path);
  if (sendMatch && method === "POST") {
    return await sendPackage(client, requireActor(actor), sendMatch[1]!, sendMatch[2]!, body);
  }

  const packagesMatch = new RegExp(`^/api/cases/(${UUID})/submissions/(${UUID})/packages$`).exec(path);
  if (packagesMatch && method === "GET") {
    return await listPackages(client, requireActor(actor), packagesMatch[1]!, packagesMatch[2]!);
  }

  const retryMatch = new RegExp(`^/api/cases/(${UUID})/submissions/(${UUID})/packages/(${UUID})/retry$`).exec(path);
  if (retryMatch && method === "POST") {
    return await retryPackage(
      client,
      requireActor(actor),
      retryMatch[1]!,
      retryMatch[2]!,
      retryMatch[3]!,
    );
  }

  throw new HttpError(404, "No such endpoint.");
}

export function createApiServer() {
  return createServer((req, res) => {
    void (async () => {
      applyCors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const method = req.method ?? "GET";
      const path = new URL(req.url ?? "/", "http://localhost").pathname;

      // The one route that carries file bytes instead of form fields — read
      // as a raw body, never through the JSON parser (which caps a request at
      // 1MB precisely because it never expects a file).
      const isUpload = method === "POST" && /^\/api\/cases\/[^/]+\/requirements\/[^/]+\/documents$/.test(path);

      try {
        const body =
          !isUpload && (method === "POST" || method === "PATCH" || method === "PUT")
            ? await readJsonBody(req)
            : {};
        const rawBody = isUpload ? await readBinaryBody(req) : null;
        const token = bearerToken(req);

        // Every request runs in one transaction with the actor's identity
        // published to Postgres (see withActor). A handler that throws rolls
        // back — a half-created case with no applicant party is not a state
        // this system should be able to reach.
        const result = await withActor(null, async (client) => {
          const actor = await loadActor(client, token);
          const inner = await withActorIdentity(client, actor, () =>
            route(client, req, method, path, body, actor, rawBody),
          );
          return inner;
        });

        if (result instanceof RawResponse) {
          res.writeHead(200, {
            "Content-Type": result.contentType,
            "Content-Length": result.bytes.byteLength,
            "Content-Disposition": `inline; filename="${result.fileName.replace(/"/g, "")}"`,
          });
          res.end(result.bytes);
          return;
        }

        json(res, 200, result);
      } catch (error) {
        // Two error types, one boundary. `HttpError` is this module's own, for
        // the plumbing above; `ApiError` (Backend/http.ts) is what the handler
        // modules raise — they cannot import from here, since this imports
        // them. Both carry a status and a message written for an employee.
        if (error instanceof HttpError || error instanceof ApiError) {
          json(res, error.status, { message: error.message });
          return;
        }

        // A stopped or unreachable PostgreSQL is not a bug in AOS, and telling
        // an employee "something went wrong, please try again" sends them
        // round a loop that cannot succeed. 503 with an actionable sentence,
        // and the driver detail stays in the server log where it belongs
        // (Stage 4 audit, area 6). Still no table names, no connection string.
        if (isDatabaseUnavailable(error)) {
          console.error("[api] database unavailable:", error);
          json(res, 503, { message: DATABASE_UNAVAILABLE_MESSAGE });
          return;
        }

        // Never return a driver error to the browser: it would carry table and
        // column names straight to anyone probing the API.
        console.error("[api] unhandled:", error);
        json(res, 500, { message: "Something went wrong. Please try again." });
      }
    })();
  });
}

/** Publish the resolved identity for the rest of the transaction, now that
 * the token has actually been exchanged for a user. */
async function withActorIdentity<T>(
  client: pg.PoolClient,
  actor: Actor | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (actor) {
    await client.query("select set_config('app.auth_identity_id', $1, true)", [
      actor.authIdentityId,
    ]);
  }
  return await fn();
}

// Started directly (`npm run api-server`) rather than imported by a test.
if (process.env.AOS_API_NO_LISTEN !== "1") {
  createApiServer().listen(PORT, HOST, () => {
    console.log(`AOS API listening on http://${HOST}:${PORT}`);
    if (HOST === "127.0.0.1" || HOST === "localhost") {
      console.log("  Loopback only — no other PC can reach this. Set AOS_API_HOST=0.0.0.0 on the office server.");
    } else {
      // Said loudly, because this is the one setting that puts AOS on the
      // office network. If it is set on a machine that is NOT the designated
      // server, two backends are now serving two different document stores
      // and nothing else in the system will notice.
      console.log(`  *** REACHABLE FROM THE OFFICE NETWORK on port ${PORT} ***`);
      console.log("  Only the designated AOS server PC should be doing this — see Docs/Deployment Topology.md.");
    }
  });
}

export { pool };
