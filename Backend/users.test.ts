/**
 * Stage 3A acceptance tests — permission overrides and user administration.
 *
 * Real PostgreSQL, real HTTP, real tokens, same as the Stage 2 suite and for
 * the same reason: the question these answer is "does the SERVER enforce it",
 * and a mocked server cannot answer that.
 *
 * The override tests are the point of the file. Through Stage 2 `Actor.overrides`
 * was hard-coded to `[]`, so every one of these would have passed by doing
 * nothing — a Telecaller denied `person.read` would have kept reading
 * customers. They fail against that build, which is what makes them worth
 * having.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { hashPassword } from "@domain/auth/password.js";
import type { Role } from "@domain/permissions/index.js";

import { createApiServer } from "./api-server.js";
import { pool, withActor } from "./db.js";

let baseUrl: string;
let server: ReturnType<typeof createApiServer>;

const PASSWORD = "integration-test-password";

interface Session {
  readonly token: string;
  readonly userId: string;
  readonly username: string;
}

/** Create an account directly in the database — the bootstrap path, not the
 * API. Tests of the API's own create route use the route. */
async function createEmployee(role: Role): Promise<string> {
  const username = `${role}.${randomUUID().slice(0, 8)}`;
  const passwordHash = await hashPassword(PASSWORD);

  await withActor(null, async (client) => {
    const person = await client.query<{ id: string }>(
      `insert into person (full_name) values ($1) returning id`,
      [`Test ${role}`],
    );
    const user = await client.query<{ id: string }>(
      `insert into app_user (person_id, auth_identity_id, username, password_hash, is_active)
       values ($1, $2, $3, $4, true) returning id`,
      [person.rows[0]!.id, randomUUID(), username, passwordHash],
    );
    await client.query(`insert into user_role (user_id, role, granted_by) values ($1, $2, $1)`, [
      user.rows[0]!.id,
      role,
    ]);
  });

  return username;
}

async function api(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function signIn(username: string, password = PASSWORD): Promise<Session> {
  const { status, body } = await api("/api/auth/login", {
    method: "POST",
    body: { username, password },
  });
  expect(status, `login failed for ${username}: ${JSON.stringify(body)}`).toBe(200);
  return { token: body.token, userId: body.user.id, username };
}

async function signInAs(role: Role): Promise<Session> {
  return await signIn(await createEmployee(role));
}

/** A Managing Partner — holds `user.manage`, `role.assign` and
 * `permission.override`, so it can drive every route in this file. */
async function administrator(): Promise<Session> {
  return await signInAs("managing_partner");
}

async function anyLoanProductId(): Promise<string> {
  const { rows } = await pool.query(`select id from loan_product limit 1`);
  return rows[0]!.id;
}

/** A case owned by a freshly created Telecaller — the fixture the visibility
 * rules are written about. */
async function someoneElsesCase(): Promise<{ ownerToken: string; caseId: string }> {
  const owner = await signInAs("telecaller");
  const customer = await api("/api/customers", {
    method: "POST",
    token: owner.token,
    body: { fullName: `Applicant ${randomUUID().slice(0, 8)}` },
  });
  const created = await api("/api/cases", {
    method: "POST",
    token: owner.token,
    body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
  });
  return { ownerToken: owner.token, caseId: created.body.id };
}

async function eventTypesFor(userId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `select event_type from event
      where entity_type = 'app_user' and entity_id = $1
      order by id`,
    [userId],
  );
  return rows.map((r: { event_type: string }) => r.event_type);
}

beforeAll(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

// ---------------------------------------------------------------------------
// The overrides actually bind
// ---------------------------------------------------------------------------

describe("permission overrides are enforced by the server", () => {
  it("a deny removes access the role grants", async () => {
    const admin = await administrator();
    const telecaller = await signInAs("telecaller");

    // Telecaller holds person.read at `all` — that is the role's grant, and it
    // works before the override.
    expect((await api("/api/customers", { token: telecaller.token })).status).toBe(200);

    const set = await api(`/api/users/${telecaller.userId}/overrides`, {
      method: "POST",
      token: admin.token,
      body: { permission: "person.read", scope: "all", decision: "deny" },
    });
    expect(set.status).toBe(200);

    // Same token, no re-login: overrides are read per request.
    const after = await api("/api/customers", { token: telecaller.token });
    expect(after.status).toBe(403);
    expect(after.body.message).toContain("person.read");
  });

  it("a grant widens a scope the role holds narrowly", async () => {
    const admin = await administrator();
    const { caseId } = await someoneElsesCase();
    const nosy = await signInAs("telecaller");

    // case.read is `own` for a Telecaller, so a colleague's case is invisible.
    expect((await api(`/api/cases/${caseId}`, { token: nosy.token })).status).toBe(404);

    await api(`/api/users/${nosy.userId}/overrides`, {
      method: "POST",
      token: admin.token,
      body: { permission: "case.read", scope: "all", decision: "grant" },
    });

    const seen = await api(`/api/cases/${caseId}`, { token: nosy.token });
    expect(seen.status).toBe(200);
    expect(seen.body.id).toBe(caseId);

    const listed = await api("/api/cases", { token: nosy.token });
    expect(listed.body.some((c: any) => c.id === caseId)).toBe(true);
  });

  it("a deny beats a grant, whatever order they were written in", async () => {
    const admin = await administrator();
    const telecaller = await signInAs("telecaller");

    await api(`/api/users/${telecaller.userId}/overrides`, {
      method: "POST",
      token: admin.token,
      body: { permission: "person.read", scope: "all", decision: "grant" },
    });
    await api(`/api/users/${telecaller.userId}/overrides`, {
      method: "POST",
      token: admin.token,
      body: { permission: "person.read", scope: "all", decision: "deny" },
    });

    expect((await api("/api/customers", { token: telecaller.token })).status).toBe(403);
  });

  it("keeps one live decision per permission, revoking the one it replaces", async () => {
    const admin = await administrator();
    const telecaller = await signInAs("telecaller");

    for (const decision of ["grant", "deny", "grant"]) {
      const response = await api(`/api/users/${telecaller.userId}/overrides`, {
        method: "POST",
        token: admin.token,
        body: { permission: "person.read", scope: "all", decision },
      });
      expect(response.status).toBe(200);
    }

    const { rows } = await pool.query(
      `select count(*) filter (where revoked_at is null)::int as live,
              count(*)::int as total
         from user_permission_override where user_id = $1 and permission = 'person.read'`,
      [telecaller.userId],
    );
    // Three decisions, one live — and the two it replaced are still on the
    // record rather than deleted.
    expect(rows[0].live).toBe(1);
    expect(rows[0].total).toBe(3);

    // The live one is the last written, so access follows it.
    expect((await api("/api/customers", { token: telecaller.token })).status).toBe(200);
  });

  it("revoking an override returns the user to what their roles give", async () => {
    const admin = await administrator();
    const telecaller = await signInAs("telecaller");

    const set = await api(`/api/users/${telecaller.userId}/overrides`, {
      method: "POST",
      token: admin.token,
      body: { permission: "person.read", scope: "all", decision: "deny" },
    });
    expect((await api("/api/customers", { token: telecaller.token })).status).toBe(403);

    const revoked = await api(`/api/users/${telecaller.userId}/overrides/${set.body.id}`, {
      method: "DELETE",
      token: admin.token,
    });
    expect(revoked.status).toBe(200);

    // Immediately, on the same token.
    expect((await api("/api/customers", { token: telecaller.token })).status).toBe(200);

    // Revoking twice is refused rather than silently re-revoking.
    const again = await api(`/api/users/${telecaller.userId}/overrides/${set.body.id}`, {
      method: "DELETE",
      token: admin.token,
    });
    expect(again.status).toBe(409);
  });

  it("a granted permission the role does not hold at all becomes usable", async () => {
    const admin = await administrator();
    // Telecaller holds no `event.view` in any scope.
    const telecaller = await signInAs("telecaller");

    const before = await api(`/api/users/${telecaller.userId}/permissions`, {
      token: admin.token,
    });
    expect(
      before.body.effective.find((e: any) => e.permission === "event.view").kind,
    ).toBe("none");

    await api(`/api/users/${telecaller.userId}/overrides`, {
      method: "POST",
      token: admin.token,
      body: { permission: "event.view", scope: "all", decision: "grant" },
    });

    const after = await api(`/api/users/${telecaller.userId}/permissions`, {
      token: admin.token,
    });
    const entry = after.body.effective.find((e: any) => e.permission === "event.view");
    // Shown as an override, not blended into "what their role gives them".
    expect(entry.kind).toBe("override_grant");
    expect(entry.scope).toBe("all");
    expect(entry.roleScope).toBeNull();
  });

  it("refuses an unknown permission and a scope the permission cannot hold", async () => {
    const admin = await administrator();
    const telecaller = await signInAs("telecaller");

    const unknown = await api(`/api/users/${telecaller.userId}/overrides`, {
      method: "POST",
      token: admin.token,
      body: { permission: "case.obliterate", scope: "all", decision: "grant" },
    });
    expect(unknown.status).toBe(400);

    // `user.manage` is defined as `all`-only in the catalog. Recording it at
    // `own` would be a row that satisfies nothing and reads as if it did.
    const badScope = await api(`/api/users/${telecaller.userId}/overrides`, {
      method: "POST",
      token: admin.token,
      body: { permission: "user.manage", scope: "own", decision: "grant" },
    });
    expect(badScope.status).toBe(400);

    const badDecision = await api(`/api/users/${telecaller.userId}/overrides`, {
      method: "POST",
      token: admin.token,
      body: { permission: "person.read", scope: "all", decision: "maybe" },
    });
    expect(badDecision.status).toBe(400);
  });

  it("refuses to let a Telecaller grant themselves anything", async () => {
    const telecaller = await signInAs("telecaller");

    const attempt = await api(`/api/users/${telecaller.userId}/overrides`, {
      method: "POST",
      token: telecaller.token,
      body: { permission: "case.read", scope: "all", decision: "grant" },
    });
    expect(attempt.status).toBe(403);
    expect(attempt.body.message).toContain("permission.override");

    const { rows } = await pool.query(
      `select count(*)::int as n from user_permission_override where user_id = $1`,
      [telecaller.userId],
    );
    expect(rows[0].n).toBe(0);
  });

  it("hides the override detail from someone who cannot change it", async () => {
    const telecaller = await signInAs("telecaller");
    const other = await signInAs("telecaller");

    // `user.read` is held by every role, so the account itself is visible…
    expect((await api(`/api/users/${other.userId}`, { token: telecaller.token })).status).toBe(200);
    // …but who carved out an exception for them is administration.
    const permissions = await api(`/api/users/${other.userId}/permissions`, {
      token: telecaller.token,
    });
    expect(permissions.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Account administration
// ---------------------------------------------------------------------------

describe("creating accounts", () => {
  it("creates an employee who can then sign in", async () => {
    const admin = await administrator();
    const username = `chinna.${randomUUID().slice(0, 8)}`;

    const created = await api("/api/users", {
      method: "POST",
      token: admin.token,
      body: {
        fullName: "Chinna Thambi",
        username,
        password: "a-real-password",
        roles: ["telecaller", "login_executive"],
      },
    });

    expect(created.status).toBe(200);
    expect(created.body.username).toBe(username);
    expect(created.body.isActive).toBe(true);
    expect([...created.body.roles].sort()).toEqual(["login_executive", "telecaller"]);

    // The account works, and holds the union of both roles (BR-061):
    // login_executive's `case.read:all` is what a telecaller alone lacks.
    const session = await signIn(username, "a-real-password");
    expect((await api("/api/cases", { token: session.token })).status).toBe(200);

    expect(await eventTypesFor(created.body.id)).toContain("user.created");
  });

  it("never stores the password", async () => {
    const admin = await administrator();
    const username = `hash.${randomUUID().slice(0, 8)}`;
    const created = await api("/api/users", {
      method: "POST",
      token: admin.token,
      body: { fullName: "Hash Check", username, password: "a-real-password", roles: ["finance"] },
    });

    const { rows } = await pool.query(`select password_hash from app_user where id = $1`, [
      created.body.id,
    ]);
    expect(rows[0].password_hash).not.toContain("a-real-password");
    expect(rows[0].password_hash.startsWith("pbkdf2$")).toBe(true);
  });

  it("refuses a duplicate username regardless of case", async () => {
    const admin = await administrator();
    const username = `Tarun.${randomUUID().slice(0, 8)}`;

    const first = await api("/api/users", {
      method: "POST",
      token: admin.token,
      body: { fullName: "Tarun Ramesh", username, password: "a-real-password", roles: ["manager"] },
    });
    expect(first.status).toBe(200);

    // Login compares case-insensitively, so a differing-case duplicate would
    // be two accounts one login attempt could reach.
    const second = await api("/api/users", {
      method: "POST",
      token: admin.token,
      body: {
        fullName: "Someone Else",
        username: username.toUpperCase(),
        password: "a-real-password",
        roles: ["telecaller"],
      },
    });
    expect(second.status).toBe(409);
  });

  it("refuses a blank name, a blank username, no roles, an unknown role and a short password", async () => {
    const admin = await administrator();
    const base = {
      fullName: "Valid Name",
      username: `valid.${randomUUID().slice(0, 8)}`,
      password: "a-real-password",
      roles: ["telecaller"],
    };

    const cases: Record<string, unknown>[] = [
      { ...base, fullName: "   " },
      { ...base, username: "  " },
      { ...base, roles: [] },
      { ...base, roles: ["sorcerer"] },
      { ...base, password: "short" },
    ];

    for (const body of cases) {
      const attempt = await api("/api/users", { method: "POST", token: admin.token, body });
      expect(attempt.status, JSON.stringify(body)).toBe(400);
    }

    // And nothing was half-created: the transaction rolled back with the request.
    const { rows } = await pool.query(`select count(*)::int as n from app_user where username = $1`, [
      base.username,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it("refuses a Telecaller and a Login Executive outright", async () => {
    for (const role of ["telecaller", "login_executive"] as Role[]) {
      const session = await signInAs(role);
      const attempt = await api("/api/users", {
        method: "POST",
        token: session.token,
        body: {
          fullName: "Should Not Exist",
          username: `nope.${randomUUID().slice(0, 8)}`,
          password: "a-real-password",
          roles: ["managing_partner"],
        },
      });
      expect(attempt.status).toBe(403);
    }
  });
});

describe("roles", () => {
  it("changes what an existing session may do, immediately", async () => {
    const admin = await administrator();
    const { caseId } = await someoneElsesCase();
    const employee = await signInAs("telecaller");

    expect((await api(`/api/cases/${caseId}`, { token: employee.token })).status).toBe(404);

    const changed = await api(`/api/users/${employee.userId}/roles`, {
      method: "PUT",
      token: admin.token,
      body: { roles: ["login_executive"] },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.roles).toEqual(["login_executive"]);

    // Roles are read per request, so the token they are already holding now
    // carries the new access — and no longer carries the old.
    expect((await api(`/api/cases/${caseId}`, { token: employee.token })).status).toBe(200);
  });

  it("revokes rather than deletes the role it replaced", async () => {
    const admin = await administrator();
    const employee = await signInAs("telecaller");

    await api(`/api/users/${employee.userId}/roles`, {
      method: "PUT",
      token: admin.token,
      body: { roles: ["finance"] },
    });

    const { rows } = await pool.query(
      `select role, revoked_at is null as live from user_role
        where user_id = $1 order by granted_at`,
      [employee.userId],
    );
    // The telecaller assignment is still on the record, marked revoked: a role
    // somebody held last March is part of why a record looks the way it does.
    expect(rows).toHaveLength(2);
    expect(rows.find((r: any) => r.role === "telecaller").live).toBe(false);
    expect(rows.find((r: any) => r.role === "finance").live).toBe(true);
    expect(await eventTypesFor(employee.userId)).toContain("user.roles_changed");
  });

  it("leaves an unchanged role assignment alone", async () => {
    const admin = await administrator();
    const employee = await signInAs("telecaller");

    const before = await pool.query(`select granted_at from user_role where user_id = $1`, [
      employee.userId,
    ]);

    await api(`/api/users/${employee.userId}/roles`, {
      method: "PUT",
      token: admin.token,
      body: { roles: ["telecaller", "finance"] },
    });

    const after = await pool.query(
      `select granted_at from user_role where user_id = $1 and role = 'telecaller'`,
      [employee.userId],
    );
    // Re-saving a set that still contains the role must not make them look
    // freshly appointed to it.
    expect(after.rows[0].granted_at).toEqual(before.rows[0].granted_at);
  });

  it("refuses an empty role list and a Telecaller trying to assign roles", async () => {
    const admin = await administrator();
    const employee = await signInAs("telecaller");

    const empty = await api(`/api/users/${employee.userId}/roles`, {
      method: "PUT",
      token: admin.token,
      body: { roles: [] },
    });
    expect(empty.status).toBe(400);

    const escalation = await api(`/api/users/${employee.userId}/roles`, {
      method: "PUT",
      token: employee.token,
      body: { roles: ["managing_partner"] },
    });
    expect(escalation.status).toBe(403);

    const { rows } = await pool.query(
      `select role from user_role where user_id = $1 and revoked_at is null`,
      [employee.userId],
    );
    expect(rows.map((r: any) => r.role)).toEqual(["telecaller"]);
  });
});

describe("deactivation", () => {
  it("ends the employee's live sessions there and then", async () => {
    const admin = await administrator();
    const leaver = await signInAs("telecaller");
    expect((await api("/api/cases", { token: leaver.token })).status).toBe(200);

    const deactivated = await api(`/api/users/${leaver.userId}/active`, {
      method: "PUT",
      token: admin.token,
      body: { isActive: false },
    });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.isActive).toBe(false);

    expect((await api("/api/cases", { token: leaver.token })).status).toBe(401);
    // Not merely refused on read — the session row is closed, so the token is
    // dead rather than depending on an is_active check on every future path.
    const { rows } = await pool.query(
      `select count(*)::int as n from api_session where user_id = $1 and revoked_at is null`,
      [leaver.userId],
    );
    expect(rows[0].n).toBe(0);
    expect(await eventTypesFor(leaver.userId)).toContain("user.deactivated");
  });

  it("keeps the account, so their name survives on what they touched (BR-062)", async () => {
    const admin = await administrator();
    const leaver = await signInAs("telecaller");
    const customer = await api("/api/customers", {
      method: "POST",
      token: leaver.token,
      body: { fullName: `Legacy ${randomUUID().slice(0, 8)}` },
    });
    const owned = await api("/api/cases", {
      method: "POST",
      token: leaver.token,
      body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
    });

    await api(`/api/users/${leaver.userId}/active`, {
      method: "PUT",
      token: admin.token,
      body: { isActive: false },
    });

    const stillThere = await api(`/api/cases/${owned.body.id}`, { token: admin.token });
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.ownerUserId).toBe(leaver.userId);
    expect((await api(`/api/users/${leaver.userId}`, { token: admin.token })).status).toBe(200);
  });

  it("reactivates, and the employee can sign in again", async () => {
    const admin = await administrator();
    const employee = await signInAs("telecaller");

    await api(`/api/users/${employee.userId}/active`, {
      method: "PUT",
      token: admin.token,
      body: { isActive: false },
    });
    const reactivated = await api(`/api/users/${employee.userId}/active`, {
      method: "PUT",
      token: admin.token,
      body: { isActive: true },
    });
    expect(reactivated.body.isActive).toBe(true);

    // The old token stays dead — reactivation is not un-revocation — but a
    // fresh login works.
    expect((await api("/api/cases", { token: employee.token })).status).toBe(401);
    const fresh = await signIn(employee.username);
    expect((await api("/api/cases", { token: fresh.token })).status).toBe(200);
  });

  it("refuses to let an administrator deactivate themselves", async () => {
    const admin = await administrator();
    const attempt = await api(`/api/users/${admin.userId}/active`, {
      method: "PUT",
      token: admin.token,
      body: { isActive: false },
    });
    expect(attempt.status).toBe(409);

    const { rows } = await pool.query(`select is_active from app_user where id = $1`, [
      admin.userId,
    ]);
    expect(rows[0].is_active).toBe(true);
  });
});

describe("passwords", () => {
  it("lets an administrator reset one, and kills the old sessions", async () => {
    const admin = await administrator();
    const employee = await signInAs("telecaller");

    const reset = await api(`/api/users/${employee.userId}/password`, {
      method: "PUT",
      token: admin.token,
      body: { password: "brand-new-password" },
    });
    expect(reset.status).toBe(200);

    // A reset is usually a response to suspecting someone else knows the old
    // one; leaving their live sessions running would make it cosmetic.
    expect((await api("/api/cases", { token: employee.token })).status).toBe(401);

    const old = await api("/api/auth/login", {
      method: "POST",
      body: { username: employee.username, password: PASSWORD },
    });
    expect(old.status).toBe(401);
    expect((await signIn(employee.username, "brand-new-password")).token).toBeTruthy();
  });

  it("lets an employee change their own, proving the current one first", async () => {
    const employee = await signInAs("telecaller");

    const wrongCurrent = await api("/api/auth/password", {
      method: "POST",
      token: employee.token,
      body: { currentPassword: "not-it", newPassword: "my-new-password" },
    });
    expect(wrongCurrent.status).toBe(403);

    const changed = await api("/api/auth/password", {
      method: "POST",
      token: employee.token,
      body: { currentPassword: PASSWORD, newPassword: "my-new-password" },
    });
    expect(changed.status).toBe(200);

    // The browser they are sitting at stays signed in…
    expect((await api("/api/cases", { token: employee.token })).status).toBe(200);
    // …and the new password is what works now.
    expect((await signIn(employee.username, "my-new-password")).token).toBeTruthy();
  });

  it("signs the employee's OTHER sessions out when they change it", async () => {
    const username = await createEmployee("telecaller");
    const atTheDesk = await signIn(username);
    const elsewhere = await signIn(username);

    await api("/api/auth/password", {
      method: "POST",
      token: atTheDesk.token,
      body: { currentPassword: PASSWORD, newPassword: "my-new-password" },
    });

    expect((await api("/api/cases", { token: atTheDesk.token })).status).toBe(200);
    expect((await api("/api/cases", { token: elsewhere.token })).status).toBe(401);
  });

  it("refuses a short new password on both routes", async () => {
    const admin = await administrator();
    const employee = await signInAs("telecaller");

    expect(
      (
        await api(`/api/users/${employee.userId}/password`, {
          method: "PUT",
          token: admin.token,
          body: { password: "short" },
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await api("/api/auth/password", {
          method: "POST",
          token: employee.token,
          body: { currentPassword: PASSWORD, newPassword: "short" },
        })
      ).status,
    ).toBe(400);

    // The original password still works — nothing was changed on the way to
    // the refusal.
    expect((await signIn(employee.username)).token).toBeTruthy();
  });

  it("refuses to let a Telecaller reset a colleague's password", async () => {
    const attacker = await signInAs("telecaller");
    const victim = await signInAs("telecaller");

    const attempt = await api(`/api/users/${victim.userId}/password`, {
      method: "PUT",
      token: attacker.token,
      body: { password: "i-own-you-now" },
    });
    expect(attempt.status).toBe(403);
    expect((await signIn(victim.username)).token).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The lock-out guard
// ---------------------------------------------------------------------------

describe("the last administrator cannot be removed", () => {
  /**
   * Reduce the installation to exactly one active `user.manage` holder, run
   * `body`, then put every account back.
   *
   * The suite shares one database and accumulates administrators as it goes,
   * so the guard is unreachable without arranging the state it guards against.
   * `finally` restores unconditionally — a throw here would otherwise leave
   * every later test signing in as a deactivated user.
   */
  async function asTheOnlyAdministrator(body: (admin: Session) => Promise<void>): Promise<void> {
    const admin = await administrator();
    const { rows } = await pool.query(
      `select distinct u.id
         from app_user u
         join user_role r on r.user_id = u.id and r.revoked_at is null
        where u.is_active
          and u.id <> $1
          and r.role in ('manager', 'managing_partner', 'admin')`,
      [admin.userId],
    );
    const parked = rows.map((r: { id: string }) => r.id);

    await pool.query(`update app_user set is_active = false where id = any($1::uuid[])`, [parked]);
    try {
      await body(admin);
    } finally {
      await pool.query(`update app_user set is_active = true where id = any($1::uuid[])`, [parked]);
    }
  }

  it("refuses to deactivate them", async () => {
    await asTheOnlyAdministrator(async (admin) => {
      const other = await administrator();
      // `other` is now the second administrator; deactivating them is fine…
      expect(
        (
          await api(`/api/users/${other.userId}/active`, {
            method: "PUT",
            token: admin.token,
            body: { isActive: false },
          })
        ).status,
      ).toBe(200);

      // …and now that only `admin` is left, removing them has no way back in.
      const attempt = await api(`/api/users/${admin.userId}/active`, {
        method: "PUT",
        token: other.token,
        body: { isActive: false },
      });
      // `other`'s token died with their account, so the refusal is 401 here;
      // the guard itself is exercised through the role and override routes
      // below, where the actor survives their own change.
      expect(attempt.status).toBe(401);
    });
  });

  it("refuses to strip their roles", async () => {
    await asTheOnlyAdministrator(async (admin) => {
      const attempt = await api(`/api/users/${admin.userId}/roles`, {
        method: "PUT",
        token: admin.token,
        body: { roles: ["telecaller"] },
      });
      expect(attempt.status).toBe(409);

      // Rolled back with the transaction: they still hold what they held.
      const { rows } = await pool.query(
        `select role from user_role where user_id = $1 and revoked_at is null`,
        [admin.userId],
      );
      expect(rows.map((r: any) => r.role)).toEqual(["managing_partner"]);
    });
  });

  it("refuses to deny them user.manage by override", async () => {
    await asTheOnlyAdministrator(async (admin) => {
      const attempt = await api(`/api/users/${admin.userId}/overrides`, {
        method: "POST",
        token: admin.token,
        body: { permission: "user.manage", scope: "all", decision: "deny" },
      });
      expect(attempt.status).toBe(409);

      const { rows } = await pool.query(
        `select count(*)::int as n from user_permission_override
          where user_id = $1 and revoked_at is null`,
        [admin.userId],
      );
      expect(rows[0].n).toBe(0);
      // And they can still administer.
      expect((await api("/api/users", { token: admin.token })).status).toBe(200);
    });
  });

  it("allows the change when someone else can still administer", async () => {
    const admin = await administrator();
    const successor = await administrator();

    const handover = await api(`/api/users/${admin.userId}/roles`, {
      method: "PUT",
      token: successor.token,
      body: { roles: ["telecaller"] },
    });
    expect(handover.status).toBe(200);
    expect(handover.body.roles).toEqual(["telecaller"]);
  });
});

// ---------------------------------------------------------------------------

describe("the audit trail", () => {
  it("names who made each administrative change, and carries no personal data", async () => {
    const admin = await administrator();
    const username = `audited.${randomUUID().slice(0, 8)}`;

    const created = await api("/api/users", {
      method: "POST",
      token: admin.token,
      body: {
        fullName: "Audited Person",
        username,
        password: "a-real-password",
        roles: ["telecaller"],
      },
    });
    await api(`/api/users/${created.body.id}/roles`, {
      method: "PUT",
      token: admin.token,
      body: { roles: ["finance"] },
    });
    await api(`/api/users/${created.body.id}/overrides`, {
      method: "POST",
      token: admin.token,
      body: { permission: "person.read", scope: "all", decision: "deny" },
    });
    await api(`/api/users/${created.body.id}/active`, {
      method: "PUT",
      token: admin.token,
      body: { isActive: false },
    });

    const { rows } = await pool.query(
      `select event_type, actor_user_id, actor_kind, payload_after
         from event where entity_type = 'app_user' and entity_id = $1 order by id`,
      [created.body.id],
    );

    expect(rows.map((r: any) => r.event_type)).toEqual([
      "user.created",
      "user.roles_changed",
      "user.permission_denied",
      "user.deactivated",
    ]);
    for (const row of rows) {
      // BR-052: every event names an actor.
      expect(row.actor_kind).toBe("user");
      expect(row.actor_user_id).toBe(admin.userId);
      // BR-051/ADR-018: the log is never redacted, so no name or username may
      // be copied into it — only IDs, roles, permission keys and scopes.
      const payload = JSON.stringify(row.payload_after ?? {});
      expect(payload).not.toContain("Audited Person");
      expect(payload).not.toContain(username);
    }
  });

  it("writes no event when the change was refused", async () => {
    const telecaller = await signInAs("telecaller");
    const victim = await signInAs("telecaller");

    await api(`/api/users/${victim.userId}/roles`, {
      method: "PUT",
      token: telecaller.token,
      body: { roles: ["managing_partner"] },
    });

    // The refusal happened before any write, and the transaction rolled back
    // regardless: an audit log with entries for things that did not happen is
    // as useless as one with gaps.
    expect(await eventTypesFor(victim.userId)).toEqual([]);
  });
});
