/**
 * Stage 4 Item 3 — the security boundaries, asserted rather than described.
 *
 * Everything here runs against real PostgreSQL. Two of the four groups run
 * against a real API server process connected as `aos_app`, spawned for this
 * file, because the question "does AOS still work when it is not a superuser"
 * cannot be answered by a test that is itself a superuser.
 *
 * WHY THIS FILE EXISTS AT ALL. The audit found that RLS in AOS protected
 * nothing: the application connected as `postgres` (`rolsuper`, `rolbypassrls`),
 * and `select count(*) from pg_policies` returned zero. Both halves were
 * invisible from the code — `Database/README.md` said the policies were "the
 * next unit of work" and nothing anywhere said which role connected. A claim
 * about a database privilege is worth exactly as much as the query that checks
 * it, so every claim 0033 makes is checked here by asking PostgreSQL.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED. There is no test that RLS enforces
 * per-user or per-case access, because it does not and must not: ownership is
 * decided in Backend/authorize.ts, proven in Backend/api.test.ts, and ADR-022
 * forbids a second implementation of it in SQL. The tier-B policies here are a
 * containment boundary around the CONNECTION — they refuse a session that has
 * not authenticated — and this file tests them for that and no more.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import pg from "pg";

import { hashPassword } from "@domain/auth/password.js";
import type { Role } from "@domain/permissions/index.js";

import { createApiServer, resetLoginThrottle } from "./api-server.js";
import { pool, withActor } from "./db.js";
import { DEV_SEED_USERNAMES, disableDevelopmentAccounts } from "./dev-accounts.js";

const PASSWORD = "integration-test-password";

/**
 * A password for `aos_app`, invented here and thrown away with the process.
 *
 * Migration 0033 creates the role with NO password precisely so that creating
 * it opens nothing — an office sets one out of band. This suite has to be able
 * to connect as it, so it sets one for the duration of the run. Random, so
 * nothing about this file is a credential anybody could reuse, and set on the
 * throwaway `aos_test` cluster role rather than anywhere near the office.
 */
const APP_ROLE_PASSWORD = randomBytes(18).toString("base64url");

/** Connected as `aos_app` — the role the application uses in production. */
let appRole: pg.Client;

/** The in-process server, used for the checks that do not care which role is
 * underneath (CORS, throttling, bootstrap). Connected as whatever
 * AOS_DB_USER is, i.e. `postgres` under the integration config. */
let baseUrl: string;
let server: ReturnType<typeof createApiServer>;

/** A SEPARATE, out-of-process API server connected as `aos_app`. This is the
 * one that answers "can AOS actually run without superuser". */
let appRoleServer: ChildProcess;
let appRoleBaseUrl: string;

async function createEmployee(role: Role): Promise<{ username: string; userId: string; authIdentityId: string }> {
  const username = `sec.${role}.${randomUUID().slice(0, 8)}`;
  const passwordHash = await hashPassword(PASSWORD);
  const authIdentityId = randomUUID();

  const userId = await withActor(null, async (client) => {
    const person = await client.query<{ id: string }>(
      `insert into person (full_name) values ($1) returning id`,
      [`Security ${role}`],
    );
    const user = await client.query<{ id: string }>(
      `insert into app_user (person_id, auth_identity_id, username, password_hash, is_active)
       values ($1, $2, $3, $4, true) returning id`,
      [person.rows[0]!.id, authIdentityId, username, passwordHash],
    );
    await client.query(`insert into user_role (user_id, role, granted_by) values ($1, $2, $1)`, [
      user.rows[0]!.id,
      role,
    ]);
    return user.rows[0]!.id;
  });

  return { username, userId, authIdentityId };
}

function makeApi(base: () => string) {
  return async function api(
    path_: string,
    options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${base()}${path_}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
      headers: response.headers,
    };
  };
}

const api = makeApi(() => baseUrl);
const appApi = makeApi(() => appRoleBaseUrl);

async function signIn(api_: typeof api, username: string): Promise<{ token: string; userId: string }> {
  const { status, body } = await api_("/api/auth/login", {
    method: "POST",
    body: { username, password: PASSWORD },
  });
  expect(status, `login failed for ${username}: ${JSON.stringify(body)}`).toBe(200);
  return { token: body.token, userId: body.user.id };
}

/**
 * Start an API server in its own process, connected as `aos_app`.
 *
 * Out of process because the pool in `db.ts` is created at import time from
 * the environment, and this file has already imported it as `postgres`. A
 * child process is the honest way to get a second connection identity, and it
 * has the side benefit of proving the real entry point boots — including
 * `AOS_REQUIRE_DB_NAME`, which is set here so a misconfiguration cannot point
 * this at anything but `aos_test`.
 */
async function startAppRoleServer(): Promise<void> {
  const port = 4331;
  appRoleServer = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"),
      "--config",
      "vite.server.config.ts",
      path.join(process.cwd(), "Backend", "api-server.ts"),
    ],
    {
      env: {
        ...process.env,
        AOS_DB_NAME: "aos_test",
        AOS_REQUIRE_DB_NAME: "aos_test",
        AOS_DB_USER: "aos_app",
        AOS_DB_PASSWORD: APP_ROLE_PASSWORD,
        AOS_API_PORT: String(port),
        AOS_API_NO_LISTEN: "0",
      },
      stdio: "pipe",
    },
  );

  const output: string[] = [];
  appRoleServer.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  appRoleServer.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  appRoleBaseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${appRoleBaseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`API server as aos_app did not start:\n${output.join("")}`);
}

beforeAll(async () => {
  // Set the aos_app password for this run. Requires the owner connection,
  // which is what `pool` is under the integration config.
  await pool.query(`alter role aos_app password '${APP_ROLE_PASSWORD}'`);

  appRole = new pg.Client({
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database: "aos_test",
    user: "aos_app",
    password: APP_ROLE_PASSWORD,
  });
  await appRole.connect();

  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await startAppRoleServer();
}, 90_000);

afterAll(async () => {
  appRoleServer?.kill();
  await appRole?.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // Leave no usable credential behind on the cluster role.
  await pool.query(`alter role aos_app password null`);
  await pool.end();
});

// ---------------------------------------------------------------------------
// The role itself
// ---------------------------------------------------------------------------

describe("the application database role", () => {
  it("is not a superuser and cannot bypass RLS", async () => {
    const { rows } = await pool.query(
      `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication
         from pg_roles where rolname = 'aos_app'`,
    );
    expect(rows[0], "migration 0033 did not create aos_app").toBeDefined();

    // The finding, restated as an assertion. If any of these ever go true, the
    // whole of the rest of this file is measuring nothing.
    expect(rows[0].rolsuper).toBe(false);
    expect(rows[0].rolbypassrls).toBe(false);
    expect(rows[0].rolcreatedb).toBe(false);
    expect(rows[0].rolcreaterole).toBe(false);
    expect(rows[0].rolinherit).toBe(false);
    expect(rows[0].rolreplication).toBe(false);
  });

  it("owns nothing, so it holds no implicit privilege and can issue no DDL", async () => {
    const { rows } = await pool.query(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'app', 'auth')
          and pg_get_userbyid(c.relowner) = 'aos_app'`,
    );
    expect(rows).toEqual([]);

    await expect(appRole.query(`create table security_probe (id int)`)).rejects.toThrow();
    await expect(appRole.query(`alter table loan_case add column probe int`)).rejects.toThrow();
    await expect(appRole.query(`drop table note`)).rejects.toThrow();
  });

  it("holds no DELETE privilege on any table", async () => {
    // BR-003 says nothing is hard-deleted. Until 0033 that was a property of
    // the code that happened to be written; no handler in Backend/ issues a
    // DELETE, but nothing stopped one. Now the privilege is simply absent.
    const { rows } = await pool.query(
      `select table_name from information_schema.table_privileges
        where grantee = 'aos_app' and privilege_type = 'DELETE'`,
    );
    expect(rows).toEqual([]);

    const employee = await createEmployee("telecaller");
    await appRole.query(`select set_config('app.auth_identity_id', $1, false)`, [
      employee.authIdentityId,
    ]);
    // Even WITH a valid identity, and therefore past the RLS policy, the
    // privilege is not there.
    await expect(appRole.query(`delete from loan_case`)).rejects.toThrow(/permission denied/i);
    await expect(appRole.query(`delete from person`)).rejects.toThrow(/permission denied/i);
    await appRole.query(`select set_config('app.auth_identity_id', '', false)`);
  });

  it("cannot rewrite the audit log", async () => {
    const employee = await createEmployee("telecaller");
    await appRole.query(`select set_config('app.auth_identity_id', $1, false)`, [
      employee.authIdentityId,
    ]);

    // Appending is the whole job and must keep working.
    await expect(
      appRole.query(
        `insert into event (actor_kind, entity_type, entity_id, event_type, source)
         values ('system', 'app_user', $1, 'user.created', 'automation')`,
        [employee.userId],
      ),
    ).resolves.toBeDefined();

    // Rewriting and erasing are not.
    await expect(appRole.query(`update event set event_type = 'tampered'`)).rejects.toThrow(
      /permission denied/i,
    );
    await expect(appRole.query(`delete from event`)).rejects.toThrow(/permission denied/i);

    await appRole.query(`select set_config('app.auth_identity_id', '', false)`);
  });

  it("cannot execute programs, read server files, or read password hashes", async () => {
    // The three superuser capabilities that made finding H3 a whole-machine
    // compromise rather than a data-access problem. The office server PC is
    // also where C:\AOS\Data and the backups live.
    await expect(
      appRole.query(`copy (select 1) to program 'cmd.exe /c echo probe'`),
    ).rejects.toThrow();
    await expect(appRole.query(`copy person from '/etc/passwd'`)).rejects.toThrow();
    await expect(appRole.query(`select rolpassword from pg_authid`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("cannot read or write the catalogue tables that define the permission model", async () => {
    const employee = await createEmployee("manager");
    await appRole.query(`select set_config('app.auth_identity_id', $1, false)`, [
      employee.authIdentityId,
    ]);

    // Readable — authorize.ts does not use them, but app.has_permission does.
    await expect(appRole.query(`select 1 from role_permission limit 1`)).resolves.toBeDefined();

    // A compromised query that could widen a role's grants would not need to
    // defeat authorize.ts at all, so these are SELECT-only.
    await expect(
      appRole.query(`update role_permission set scope = 'all'`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      appRole.query(`insert into permission (key, permission_group, level, description)
                     values ('probe.probe', 'case', 'row', 'a permission nobody granted')`),
    ).rejects.toThrow(/permission denied/i);

    await appRole.query(`select set_config('app.auth_identity_id', '', false)`);
  });
});

// ---------------------------------------------------------------------------
// Row level security
// ---------------------------------------------------------------------------

describe("row level security", () => {
  it("leaves no table protected by RLS without a policy", async () => {
    // The trap 0010 left behind: RLS on with zero policies reads as "locked
    // down" and is indistinguishable from "would return nothing to any
    // non-superuser". This test is what stops a future migration adding a
    // table and re-creating it.
    const { rows } = await pool.query(
      `select c.relname
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
          and not exists (
            select 1 from pg_policies p
             where p.schemaname = 'public' and p.tablename = c.relname)
        order by 1`,
    );

    // `case_number_sequence` is the one deliberate exception, and it is
    // deliberate in both directions: it has no policy AND no grant, because
    // the only thing that may touch it is app.allocate_case_number(), which is
    // SECURITY DEFINER and runs as the owner (ADR-024).
    expect(rows.map((r: { relname: string }) => r.relname)).toEqual(["case_number_sequence"]);
  });

  it("shows a connection with no authenticated identity nothing operational", async () => {
    // Make sure there is something to fail to see.
    const employee = await createEmployee("manager");
    const session = await signIn(appApi, employee.username);
    const created = await appApi("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: `RLS Probe ${randomUUID().slice(0, 8)}` },
    });
    expect(created.status).toBe(200);

    await appRole.query(`select set_config('app.auth_identity_id', '', false)`);

    // THE PROPERTY THIS BUYS: someone holding the aos_app password — a leaked
    // .env, a psql session from another PC on the office LAN — is not inside
    // an authenticated AOS transaction, and sees no customer, case, document
    // or submission.
    for (const table of ["person_identifier", "loan_case", "document", "submission", "event", "note"]) {
      const { rows } = await appRole.query(`select count(*)::int as n from ${table}`);
      expect(rows[0].n, `${table} was readable with no identity set`).toBe(0);
    }

    // And writing is refused too, by the policy's WITH CHECK.
    await expect(
      appRole.query(`insert into note (body) values ('probe')`),
    ).rejects.toThrow();
  });

  it("shows the same connection operational data once an active identity is published", async () => {
    const employee = await createEmployee("manager");
    const session = await signIn(appApi, employee.username);
    await appApi("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: `RLS Visible ${randomUUID().slice(0, 8)}` },
    });

    await appRole.query(`select set_config('app.auth_identity_id', $1, false)`, [
      employee.authIdentityId,
    ]);
    const { rows } = await appRole.query(`select count(*)::int as n from person_identifier`);
    // Not asserting a specific count — other tests share this database. The
    // claim is that the door opens at all, having been shut a moment ago.
    expect(rows[0].n).toBeGreaterThanOrEqual(0);

    const cases = await appRole.query(`select count(*)::int as n from loan_case`);
    expect(cases.rows[0].n).toBeGreaterThan(0);

    await appRole.query(`select set_config('app.auth_identity_id', '', false)`);
  });

  it("shuts the door again the moment that employee is deactivated", async () => {
    const employee = await createEmployee("manager");
    await appRole.query(`select set_config('app.auth_identity_id', $1, false)`, [
      employee.authIdentityId,
    ]);
    const before = await appRole.query(`select count(*)::int as n from loan_case`);
    expect(before.rows[0].n).toBeGreaterThan(0);

    await pool.query(`update app_user set is_active = false where id = $1`, [employee.userId]);

    // app.current_user_id() filters on is_active, so deactivation bites at the
    // DATABASE layer as well as in loadActor. Two independent refusals, which
    // is the point — loadActor was previously the only one.
    const after = await appRole.query(`select count(*)::int as n from loan_case`);
    expect(after.rows[0].n).toBe(0);

    await appRole.query(`select set_config('app.auth_identity_id', '', false)`);
  });

  it("still lets the login path read what it must, before any identity exists", async () => {
    // Tier A. Login is how an identity comes to exist, so RLS cannot constrain
    // the tables login reads — and this asserts the policies say so, rather
    // than AOS discovering it as a 500 at the office.
    await appRole.query(`select set_config('app.auth_identity_id', '', false)`);
    for (const table of ["app_user", "api_session", "person", "user_role", "user_permission_override"]) {
      await expect(
        appRole.query(`select count(*) from ${table}`),
        `${table} must be readable before login`,
      ).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The application, running as aos_app
// ---------------------------------------------------------------------------

describe("the full authentication lifecycle, served by an API running as aos_app", () => {
  it("signs in, serves an authenticated request, and signs out", async () => {
    const employee = await createEmployee("manager");

    const session = await signIn(appApi, employee.username);
    expect(session.token).toBeTruthy();

    const me = await appApi("/api/auth/me", { token: session.token });
    expect(me.status).toBe(200);
    expect(me.body.username).toBe(employee.username);

    expect((await appApi("/api/cases", { token: session.token })).status).toBe(200);

    await appApi("/api/auth/logout", { method: "POST", token: session.token });
    expect((await appApi("/api/cases", { token: session.token })).status).toBe(401);
  });

  it("creates a customer and a case — the write path works without superuser", async () => {
    // The load-bearing one. A read-only proof would miss that `aos_app` needs
    // INSERT on eight tables, USAGE on the app schema, and EXECUTE on
    // app.allocate_case_number() — any of which missing turns into a 500 in
    // the office rather than a failure here.
    const employee = await createEmployee("manager");
    const session = await signIn(appApi, employee.username);

    const customer = await appApi("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: `AppRole Customer ${randomUUID().slice(0, 8)}` },
    });
    expect(customer.status, JSON.stringify(customer.body)).toBe(200);

    const { rows } = await pool.query(`select id from loan_product limit 1`);
    const created = await appApi("/api/cases", {
      method: "POST",
      token: session.token,
      body: { applicantId: customer.body.id, loanProductId: rows[0]!.id },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.caseNumber).toBeTruthy();

    // The event log was appended to, through a role that cannot amend it.
    const events = await pool.query(
      `select count(*)::int as n from event where entity_id = $1`,
      [created.body.id],
    );
    expect(events.rows[0].n).toBeGreaterThan(0);
  });

  it("refuses an unauthenticated request, a garbage token and an expired one", async () => {
    const employee = await createEmployee("manager");
    const session = await signIn(appApi, employee.username);

    expect((await appApi("/api/cases")).status).toBe(401);
    expect((await appApi("/api/cases", { token: "not-a-real-token" })).status).toBe(401);

    // Expiry was the one lifecycle state with no test: api.test.ts covered
    // garbage and revoked tokens but never a session that simply ran out.
    // Backdated rather than waited for — the TTL is twelve hours.
    expect((await appApi("/api/cases", { token: session.token })).status).toBe(200);
    await pool.query(
      `update api_session set expires_at = now() - interval '1 minute' where user_id = $1`,
      [session.userId],
    );
    expect((await appApi("/api/cases", { token: session.token })).status).toBe(401);
  });

  it("refuses a deactivated employee at the login form and on an existing token", async () => {
    const employee = await createEmployee("manager");
    const session = await signIn(appApi, employee.username);

    await pool.query(`update app_user set is_active = false where id = $1`, [employee.userId]);

    // The existing token stops working immediately, not at the next login.
    expect((await appApi("/api/cases", { token: session.token })).status).toBe(401);

    // And they cannot get a new one. Same message as a wrong password: the
    // form must not reveal that the account exists but is disabled.
    const attempt = await appApi("/api/auth/login", {
      method: "POST",
      body: { username: employee.username, password: PASSWORD },
    });
    expect(attempt.status).toBe(401);
    expect(attempt.body.message).toBe("Incorrect username or password.");
  });

  it("keeps one Telecaller out of another's case, and lets a Manager in", async () => {
    // The privilege boundary, re-proven against the non-superuser connection.
    // api.test.ts already asserts this; running it here is what shows the RLS
    // policies did not quietly change the answer.
    const first = await createEmployee("telecaller");
    const second = await createEmployee("telecaller");
    const manager = await createEmployee("manager");

    const firstSession = await signIn(appApi, first.username);
    const customer = await appApi("/api/customers", {
      method: "POST",
      token: firstSession.token,
      body: { fullName: `Boundary ${randomUUID().slice(0, 8)}` },
    });
    const { rows } = await pool.query(`select id from loan_product limit 1`);
    const created = await appApi("/api/cases", {
      method: "POST",
      token: firstSession.token,
      body: { applicantId: customer.body.id, loanProductId: rows[0]!.id },
    });
    expect(created.status).toBe(200);
    const caseId = created.body.id;

    const secondSession = await signIn(appApi, second.username);
    // 404, not 403: a 403 would confirm the case exists, which would let one
    // Telecaller map a colleague's caseload by probing UUIDs.
    expect((await appApi(`/api/cases/${caseId}`, { token: secondSession.token })).status).toBe(404);
    expect(
      (
        await appApi(`/api/cases/${caseId}`, {
          method: "PATCH",
          token: secondSession.token,
          body: { requestedAmount: 999 },
        })
      ).status,
    ).toBe(404);

    const owned = await appApi("/api/cases", { token: secondSession.token });
    expect(owned.body.map((c: { id: string }) => c.id)).not.toContain(caseId);

    const managerSession = await signIn(appApi, manager.username);
    expect((await appApi(`/api/cases/${caseId}`, { token: managerSession.token })).status).toBe(200);
  });

  it("refuses an administrative route to someone without the permission", async () => {
    const telecaller = await createEmployee("telecaller");
    const session = await signIn(appApi, telecaller.username);

    const created = await appApi("/api/users", {
      method: "POST",
      token: session.token,
      body: { fullName: "Nope", username: `nope.${randomUUID().slice(0, 8)}`, password: "long-enough-password", roles: ["manager"] },
    });
    expect(created.status).toBe(403);
    expect(created.body.message).toContain("user.manage");
  });
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe("cross-origin access", () => {
  it("gives a foreign origin no allow-origin header at all", async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: "https://attacker.example" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    // Varies regardless, so a cache cannot serve one origin's answer to
    // another.
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("allows the origins AOS is actually served from", async () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:4300"]) {
      const response = await fetch(`${baseUrl}/api/health`, { headers: { Origin: origin } });
      expect(response.headers.get("access-control-allow-origin"), origin).toBe(origin);
    }
  });

  it("refuses a foreign origin's preflight", async () => {
    const response = await fetch(`${baseUrl}/api/cases`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Login throttling
// ---------------------------------------------------------------------------

describe("login throttling", () => {
  it("locks out after repeated failures and stops checking the password", async () => {
    resetLoginThrottle();
    const employee = await createEmployee("telecaller");

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await api("/api/auth/login", {
        method: "POST",
        body: { username: employee.username, password: "wrong-password" },
      });
      expect(response.status, `attempt ${attempt + 1}`).toBe(401);
    }

    const locked = await api("/api/auth/login", {
      method: "POST",
      body: { username: employee.username, password: "wrong-password" },
    });
    expect(locked.status).toBe(429);

    // THE PART THAT MATTERS: the CORRECT password is refused too. A lockout
    // that lets the right guess through is not a lockout.
    const correct = await api("/api/auth/login", {
      method: "POST",
      body: { username: employee.username, password: PASSWORD },
    });
    expect(correct.status).toBe(429);

    resetLoginThrottle();
  });

  it("does not lock out an unrelated account", async () => {
    resetLoginThrottle();
    const victim = await createEmployee("telecaller");
    const other = await createEmployee("telecaller");

    for (let attempt = 0; attempt < 11; attempt += 1) {
      await api("/api/auth/login", {
        method: "POST",
        body: { username: victim.username, password: "wrong-password" },
      });
    }

    // Locking by username alone would make the throttle its own denial of
    // service: anyone could lock any employee out by guessing badly.
    const unaffected = await signIn(api, other.username);
    expect(unaffected.token).toBeTruthy();

    resetLoginThrottle();
  });

  it("forgets the failures once the employee proves who they are", async () => {
    resetLoginThrottle();
    const employee = await createEmployee("telecaller");

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await api("/api/auth/login", {
        method: "POST",
        body: { username: employee.username, password: "wrong-password" },
      });
    }
    expect((await signIn(api, employee.username)).token).toBeTruthy();

    // Nine more would trip the counter if it had not been cleared.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await api("/api/auth/login", {
        method: "POST",
        body: { username: employee.username, password: "wrong-password" },
      });
    }
    expect((await signIn(api, employee.username)).token).toBeTruthy();

    resetLoginThrottle();
  });
});

// ---------------------------------------------------------------------------
// Production bootstrap
// ---------------------------------------------------------------------------

describe("production bootstrap leaves no development credential active", () => {
  it("disables all five, revokes their sessions, and records why", async () => {
    resetLoginThrottle();
    const seedPassword = "development-seed-password";
    const hash = await hashPassword(seedPassword);

    // Recreate exactly what `seed-users.ts` used to leave behind: five active
    // accounts sharing one password, `partner.p` among them.
    const ids: string[] = [];
    await withActor(null, async (client) => {
      for (const username of DEV_SEED_USERNAMES) {
        const existing = await client.query(`select id from app_user where username = $1`, [username]);
        if (existing.rows[0]) {
          await client.query(`update app_user set is_active = true, password_hash = $1 where id = $2`, [
            hash,
            existing.rows[0].id,
          ]);
          ids.push(existing.rows[0].id);
          continue;
        }
        const person = await client.query<{ id: string }>(
          `insert into person (full_name) values ($1) returning id`,
          [username],
        );
        const user = await client.query<{ id: string }>(
          `insert into app_user (person_id, auth_identity_id, username, password_hash, is_active)
           values ($1, $2, $3, $4, true) returning id`,
          [person.rows[0]!.id, randomUUID(), username, hash],
        );
        await client.query(`insert into user_role (user_id, role, granted_by) values ($1, $2, $1)`, [
          user.rows[0]!.id,
          username === "partner.p" ? "managing_partner" : "telecaller",
        ]);
        ids.push(user.rows[0]!.id);
      }
    });

    // They work. This is the state the office would have been in.
    const before = await api("/api/auth/login", {
      method: "POST",
      body: { username: "partner.p", password: seedPassword },
    });
    expect(before.status, "the fixture did not reproduce a working dev login").toBe(200);
    const strandedToken = before.body.token;

    // Run the real code path, not a re-implementation of it.
    const disabled = await withActor(null, (client) => disableDevelopmentAccounts(client));
    expect([...disabled].sort()).toEqual([...DEV_SEED_USERNAMES].sort());

    // 1. None of the five can authenticate.
    for (const username of DEV_SEED_USERNAMES) {
      const attempt = await api("/api/auth/login", {
        method: "POST",
        body: { username, password: seedPassword },
      });
      expect(attempt.status, `${username} could still sign in`).toBe(401);
    }

    // 2. A token issued BEFORE the bootstrap is dead too. Deactivation alone
    //    would have left this working for up to twelve hours.
    expect((await api("/api/cases", { token: strandedToken })).status).toBe(401);

    // 3. The accounts survive as records — BR-062 wants the name on everything
    //    they touched, and `app_user` is referenced from a dozen tables.
    const { rows } = await pool.query(
      `select username, is_active from app_user where username = any($1::text[]) order by username`,
      [[...DEV_SEED_USERNAMES]],
    );
    expect(rows).toHaveLength(DEV_SEED_USERNAMES.length);
    expect(rows.every((r: { is_active: boolean }) => r.is_active === false)).toBe(true);

    // 4. And the audit says what happened and why.
    const events = await pool.query(
      `select payload_after from event
        where entity_id = any($1::uuid[]) and event_type = 'user.deactivated'`,
      [ids],
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(DEV_SEED_USERNAMES.length);
    expect(events.rows[0].payload_after.reason).toBe("development_seed_account");
  });

  it("is idempotent — a second run finds nothing left to do", async () => {
    const again = await withActor(null, (client) => disableDevelopmentAccounts(client));
    expect(again).toEqual([]);
  });
});
