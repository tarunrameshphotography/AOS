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
import { ApiError } from "./http.js";
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

const PORT = Number(process.env.AOS_API_PORT ?? 4321);

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

/** The office runs the frontend on 5173 and this on 4321 — different origins,
 * so the browser requires these. Not a wildcard on credentials: the token
 * travels in an Authorization header, which `*` would still allow, but being
 * explicit here keeps a later cookie switch from silently becoming permissive. */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Vary", "Origin");
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

async function login(client: pg.PoolClient, body: Record<string, unknown>) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  const { rows } = await client.query(
    `select id, password_hash, is_active from app_user where lower(username) = lower($1)`,
    [username],
  );
  const user = rows[0];

  // One message for "no such user", "wrong password" and "deactivated". The
  // login form must not become a way to enumerate who works here, or to learn
  // that a departed employee's account still exists.
  const rejection = new HttpError(401, "Incorrect username or password.");
  if (!user || !user.password_hash) throw rejection;
  if (!(await verifyPassword(password, user.password_hash))) throw rejection;
  if (!user.is_active) throw rejection;

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

  if (method === "POST" && path === "/api/auth/login") return await login(client, body);

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
  createApiServer().listen(PORT, "127.0.0.1", () => {
    console.log(`AOS API listening on http://127.0.0.1:${PORT}`);
  });
}

export { pool };
