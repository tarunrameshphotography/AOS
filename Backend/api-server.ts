#!/usr/bin/env node
/**
 * The AOS application API.
 *
 * Stage 2 of the Persistence milestone: ONE vertical slice — customers and
 * cases — proved end to end against PostgreSQL, so the architecture is
 * demonstrated before the other ~85 store functions are ported to it.
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
 *   - Everything outside the slice: requirements, verification, submissions,
 *     the event log. Stage 2 is a proof, not the migration.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

import { verifyPassword } from "@domain/auth/password.js";
import type { Role } from "@domain/permissions/index.js";

import { pool, withActor } from "./db.js";
import { can, canActOnCase, refusal, widestScopeFor, type Actor } from "./authorize.js";

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
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
    // See Actor's doc comment: `permission_override` has no table yet.
    overrides: [],
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
  return { id: row.id, username: row.username, fullName: row.full_name, roles: row.roles };
}

// ---------------------------------------------------------------------------
// Handlers — customers (the `person` table)
// ---------------------------------------------------------------------------

const CUSTOMER_COLUMNS = `id, full_name, date_of_birth, address_line, locality, city,
                          district, state, pincode, is_active, created_at, updated_at`;

function customerFromRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    fullName: row.full_name,
    dateOfBirth: row.date_of_birth,
    addressLine: row.address_line,
    locality: row.locality,
    city: row.city,
    district: row.district,
    state: row.state,
    pincode: row.pincode,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Field name in the API → column in `person`. A whitelist, not a loop over
 * the body: without it, `PATCH` would happily set `created_by` or clear
 * `merged_into_id`. */
const CUSTOMER_WRITABLE: Record<string, string> = {
  fullName: "full_name",
  dateOfBirth: "date_of_birth",
  addressLine: "address_line",
  locality: "locality",
  city: "city",
  district: "district",
  state: "state",
  pincode: "pincode",
};

async function listCustomers(client: pg.PoolClient, actor: Actor) {
  requirePermission(actor, "person.read", "all");
  const { rows } = await client.query(
    `select ${CUSTOMER_COLUMNS} from person
      where is_active and merged_into_id is null
      order by created_at desc limit 500`,
  );
  return rows.map(customerFromRow);
}

async function createCustomer(client: pg.PoolClient, actor: Actor, body: Record<string, unknown>) {
  requirePermission(actor, "person.create", "all");

  const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
  if (fullName.length === 0) throw new HttpError(400, "A customer needs a name.");

  const columns = ["full_name", "created_by"];
  const values: unknown[] = [fullName, actor.userId];
  for (const [field, column] of Object.entries(CUSTOMER_WRITABLE)) {
    if (field === "fullName") continue;
    if (body[field] !== undefined && body[field] !== null && body[field] !== "") {
      columns.push(column);
      values.push(body[field]);
    }
  }

  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await client.query(
    `insert into person (${columns.join(", ")}) values (${placeholders})
     returning ${CUSTOMER_COLUMNS}`,
    values,
  );
  return customerFromRow(rows[0]!);
}

async function getCustomer(client: pg.PoolClient, actor: Actor, id: string) {
  requirePermission(actor, "person.read", "all");
  const { rows } = await client.query(
    `select ${CUSTOMER_COLUMNS} from person where id = $1`,
    [id],
  );
  if (!rows[0]) throw new HttpError(404, "No such customer.");
  return customerFromRow(rows[0]);
}

async function updateCustomer(
  client: pg.PoolClient,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  requirePermission(actor, "person.update", "all");

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(CUSTOMER_WRITABLE)) {
    if (body[field] !== undefined) {
      values.push(body[field]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) throw new HttpError(400, "Nothing to update.");

  values.push(id);
  const { rows } = await client.query(
    `update person set ${sets.join(", ")} where id = $${values.length}
     returning ${CUSTOMER_COLUMNS}`,
    values,
  );
  if (!rows[0]) throw new HttpError(404, "No such customer.");
  return customerFromRow(rows[0]);
}

// ---------------------------------------------------------------------------
// Handlers — cases (the `loan_case` table)
// ---------------------------------------------------------------------------

const CASE_COLUMNS = `c.id, c.case_number, c.loan_product_id, c.requested_amount, c.stage,
                      c.owner_user_id, c.source, c.is_on_hold, c.created_at, c.updated_at`;

function caseFromRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    caseNumber: row.case_number,
    loanProductId: row.loan_product_id,
    requestedAmount: row.requested_amount === null ? null : Number(row.requested_amount),
    stage: row.stage,
    ownerUserId: row.owner_user_id,
    source: row.source,
    isOnHold: row.is_on_hold,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    applicantId: row.applicant_id ?? null,
    applicantName: row.applicant_name ?? null,
  };
}

/**
 * The scope rule, as a SQL filter.
 *
 * A Telecaller holds `case.read` at `own`, a Login Executive and above at
 * `all` (src/domain/permissions/roles.ts). So this is not a convenience —
 * without the `own` branch, one Telecaller would list another Telecaller's
 * cases, which is the precise thing Stage 2 has to prove cannot happen.
 */
async function listCases(client: pg.PoolClient, actor: Actor) {
  const scope = widestScopeFor(actor, "case.read");
  if (scope === null) throw new HttpError(403, refusal("case.read"));

  const ownOnly = scope === "own";
  const { rows } = await client.query(
    `select ${CASE_COLUMNS},
            pa.person_id as applicant_id, p.full_name as applicant_name
       from loan_case c
       left join case_party pa
              on pa.case_id = c.id and pa.is_primary and pa.removed_at is null
       left join person p on p.id = pa.person_id
      ${ownOnly ? "where c.owner_user_id = $1" : ""}
      order by c.created_at desc limit 500`,
    ownOnly ? [actor.userId] : [],
  );
  return rows.map(caseFromRow);
}

async function createCase(client: pg.PoolClient, actor: Actor, body: Record<string, unknown>) {
  requirePermission(actor, "case.create", "all");

  const applicantId = typeof body.applicantId === "string" ? body.applicantId : null;
  const loanProductId = typeof body.loanProductId === "string" ? body.loanProductId : null;
  if (!applicantId) throw new HttpError(400, "A case needs an applicant.");
  if (!loanProductId) throw new HttpError(400, "A case needs a loan product.");

  const applicant = await client.query(`select id from person where id = $1`, [applicantId]);
  if (!applicant.rows[0]) throw new HttpError(400, "No such customer.");

  const product = await client.query(`select id from loan_product where id = $1`, [loanProductId]);
  if (!product.rows[0]) throw new HttpError(400, "No such loan product.");

  // ADR-024: the number comes from the sequence function, never from the
  // application. Two PCs creating a case at the same moment is exactly the
  // case the row lock in there exists for.
  const numbered = await client.query<{ case_number: string }>(
    `select app.allocate_case_number() as case_number`,
  );
  const caseNumber = numbered.rows[0]!.case_number;

  // A case is owned by whoever created it. Reassignment is `case.assign`, a
  // separate permission and a later slice.
  const inserted = await client.query(
    `insert into loan_case (case_number, loan_product_id, requested_amount, stage,
                            owner_user_id, source, created_by)
     values ($1, $2, $3, 'new', $4, $5, $4)
     returning id`,
    [
      caseNumber,
      loanProductId,
      body.requestedAmount ?? null,
      actor.userId,
      typeof body.source === "string" ? body.source : null,
    ],
  );
  const caseId = inserted.rows[0]!.id;

  await client.query(
    `insert into case_party (case_id, person_id, role, is_primary, created_by)
     values ($1, $2, 'applicant', true, $3)`,
    [caseId, applicantId, actor.userId],
  );

  return await readCase(client, actor, caseId);
}

/**
 * Read one case, enforcing ownership.
 *
 * Refuses with 404 rather than 403 when the actor may not see it. 403 would
 * confirm the case exists, which is itself information: a Telecaller probing
 * `/api/cases/<uuid>` could map colleagues' caseload without reading a single
 * field. "No such case, or you do not have access to it" is the honest answer
 * to both questions at once.
 */
async function readCase(client: pg.PoolClient, actor: Actor, id: string) {
  if (widestScopeFor(actor, "case.read") === null) {
    throw new HttpError(403, refusal("case.read"));
  }

  const { rows } = await client.query(
    `select ${CASE_COLUMNS},
            pa.person_id as applicant_id, p.full_name as applicant_name
       from loan_case c
       left join case_party pa
              on pa.case_id = c.id and pa.is_primary and pa.removed_at is null
       left join person p on p.id = pa.person_id
      where c.id = $1`,
    [id],
  );
  const row = rows[0];
  const notFound = new HttpError(404, "No such case, or you do not have access to it.");
  if (!row) throw notFound;
  if (!canActOnCase(actor, row.owner_user_id, "case.read")) throw notFound;
  return caseFromRow(row);
}

const CASE_WRITABLE: Record<string, string> = {
  requestedAmount: "requested_amount",
  source: "source",
  stage: "stage",
};

async function updateCase(
  client: pg.PoolClient,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const { rows: existing } = await client.query(
    `select owner_user_id from loan_case where id = $1`,
    [id],
  );
  const current = existing[0];
  const notFound = new HttpError(404, "No such case, or you do not have access to it.");
  if (!current) throw notFound;

  // Read access decides whether the case is even acknowledged; write access is
  // checked separately, so someone who may see a case but not edit it gets a
  // 403 that names the permission rather than a misleading 404.
  if (!canActOnCase(actor, current.owner_user_id, "case.read")) throw notFound;
  if (!canActOnCase(actor, current.owner_user_id, "case.update")) {
    throw new HttpError(403, refusal("case.update"));
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, column] of Object.entries(CASE_WRITABLE)) {
    if (body[field] !== undefined) {
      values.push(body[field]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) throw new HttpError(400, "Nothing to update.");

  values.push(id);
  await client.query(
    `update loan_case set ${sets.join(", ")} where id = $${values.length}`,
    values,
  );
  return await readCase(client, actor, id);
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

  if (method === "GET" && path === "/api/customers") {
    return await listCustomers(client, requireActor(actor));
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

      try {
        const body = method === "POST" || method === "PATCH" ? await readJsonBody(req) : {};
        const token = bearerToken(req);

        // Every request runs in one transaction with the actor's identity
        // published to Postgres (see withActor). A handler that throws rolls
        // back — a half-created case with no applicant party is not a state
        // this system should be able to reach.
        const result = await withActor(null, async (client) => {
          const actor = await loadActor(client, token);
          const inner = await withActorIdentity(client, actor, () =>
            route(client, req, method, path, body, actor),
          );
          return inner;
        });

        json(res, 200, result);
      } catch (error) {
        if (error instanceof HttpError) {
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
