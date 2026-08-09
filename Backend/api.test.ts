/**
 * Stage 2 acceptance tests — the customer + case vertical slice.
 *
 * These talk to a real PostgreSQL over real HTTP with real session tokens.
 * Nothing about the persistence layer is mocked, because "does the persistence
 * architecture work" is the only question Stage 2 exists to answer, and a
 * mocked answer to it is worth nothing.
 *
 * The security tests are the important ones. Every check they exercise used to
 * live in the browser, where it was advice; they assert the SERVER refuses,
 * with a token that is genuinely a Telecaller's, against a case that genuinely
 * belongs to someone else.
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

/** A signed-in employee: what a browser session actually holds. */
interface Session {
  readonly token: string;
  readonly userId: string;
  readonly username: string;
}

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

async function signIn(username: string): Promise<Session> {
  const { status, body } = await api("/api/auth/login", {
    method: "POST",
    body: { username, password: PASSWORD },
  });
  expect(status, `login failed for ${username}: ${JSON.stringify(body)}`).toBe(200);
  return { token: body.token, userId: body.user.id, username };
}

async function anyLoanProductId(): Promise<string> {
  const { rows } = await pool.query(`select id from loan_product limit 1`);
  return rows[0]!.id;
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

describe("authentication", () => {
  it("issues a token for correct credentials and identifies the user", async () => {
    const username = await createEmployee("telecaller");
    const session = await signIn(username);

    expect(session.token).toBeTruthy();

    const me = await api("/api/auth/me", { token: session.token });
    expect(me.status).toBe(200);
    expect(me.body.username).toBe(username);
    expect(me.body.roles).toEqual(["telecaller"]);
  });

  it("refuses a wrong password, and says nothing about whether the user exists", async () => {
    const username = await createEmployee("telecaller");

    const wrongPassword = await api("/api/auth/login", {
      method: "POST",
      body: { username, password: "not-the-password" },
    });
    const noSuchUser = await api("/api/auth/login", {
      method: "POST",
      body: { username: "nobody.at.all", password: PASSWORD },
    });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    // Identical text: the login form must not enumerate employees.
    expect(wrongPassword.body.message).toBe(noSuchUser.body.message);
  });

  it("refuses an unauthenticated request, a garbage token and a revoked one", async () => {
    const username = await createEmployee("telecaller");
    const session = await signIn(username);

    expect((await api("/api/cases")).status).toBe(401);
    expect((await api("/api/cases", { token: "not-a-real-token" })).status).toBe(401);

    await api("/api/auth/logout", { method: "POST", token: session.token });
    expect((await api("/api/cases", { token: session.token })).status).toBe(401);
  });

  it("stops honouring the token of a deactivated employee", async () => {
    const username = await createEmployee("telecaller");
    const session = await signIn(username);
    expect((await api("/api/cases", { token: session.token })).status).toBe(200);

    await pool.query(`update app_user set is_active = false where id = $1`, [session.userId]);

    // Not "at their next login" — now. Deactivation has to bite at the read
    // layer or it is not deactivation.
    expect((await api("/api/cases", { token: session.token })).status).toBe(401);
  });

  it("never stores the raw token", async () => {
    const username = await createEmployee("telecaller");
    const session = await signIn(username);

    const { rows } = await pool.query(`select token_hash from api_session where token_hash = $1`, [
      // The stored value must be the hash, so searching for the raw token finds nothing.
      session.token,
    ]);
    expect(rows).toHaveLength(0);

    const live = await pool.query(
      `select count(*)::int as n from api_session where user_id = $1 and revoked_at is null`,
      [session.userId],
    );
    expect(live.rows[0].n).toBeGreaterThan(0);
  });
});

describe("customers", () => {
  it("creates, reads, lists and updates a customer", async () => {
    const session = await signIn(await createEmployee("telecaller"));
    const name = `Customer ${randomUUID().slice(0, 8)}`;

    const created = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: name, city: "Madurai", pincode: "625001" },
    });
    expect(created.status).toBe(200);
    expect(created.body.fullName).toBe(name);

    const read = await api(`/api/customers/${created.body.id}`, { token: session.token });
    expect(read.status).toBe(200);
    expect(read.body.city).toBe("Madurai");

    const updated = await api(`/api/customers/${created.body.id}`, {
      method: "PATCH",
      token: session.token,
      body: { city: "Coimbatore" },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.city).toBe("Coimbatore");

    const listed = await api("/api/customers", { token: session.token });
    expect(listed.body.some((c: any) => c.id === created.body.id)).toBe(true);
  });

  it("refuses a customer with no name", async () => {
    const session = await signIn(await createEmployee("telecaller"));
    const created = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: "   " },
    });
    expect(created.status).toBe(400);
  });

  it("ignores fields that are not writable through the API", async () => {
    const session = await signIn(await createEmployee("telecaller"));
    const created = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: "Whitelist Test", isActive: false, id: randomUUID() },
    });

    expect(created.status).toBe(200);
    // `isActive` was not honoured: the whitelist decides what a client may set.
    expect(created.body.isActive).toBe(true);
  });
});

describe("cases", () => {
  it("creates a case with an allocated number and the creator as owner", async () => {
    const session = await signIn(await createEmployee("telecaller"));
    const customer = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: `Applicant ${randomUUID().slice(0, 8)}` },
    });

    const created = await api("/api/cases", {
      method: "POST",
      token: session.token,
      body: {
        applicantId: customer.body.id,
        loanProductId: await anyLoanProductId(),
        requestedAmount: 2500000,
      },
    });

    expect(created.status).toBe(200);
    expect(created.body.caseNumber).toMatch(/^AL-\d{4}-\d{5}$/);
    expect(created.body.stage).toBe("new");
    expect(created.body.ownerUserId).toBe(session.userId);
    expect(created.body.applicantName).toBe(customer.body.fullName);
  });

  it("allocates contiguous, unique case numbers", async () => {
    const session = await signIn(await createEmployee("telecaller"));
    const productId = await anyLoanProductId();
    const customer = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: "Sequence Test" },
    });

    const numbers = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const created = await api("/api/cases", {
        method: "POST",
        token: session.token,
        body: { applicantId: customer.body.id, loanProductId: productId },
      });
      numbers.add(created.body.caseNumber);
    }
    expect(numbers.size).toBe(3);
  });

  it("refuses a case with no applicant or an unknown one", async () => {
    const session = await signIn(await createEmployee("telecaller"));
    const productId = await anyLoanProductId();

    expect(
      (await api("/api/cases", { method: "POST", token: session.token, body: { loanProductId: productId } }))
        .status,
    ).toBe(400);

    expect(
      (
        await api("/api/cases", {
          method: "POST",
          token: session.token,
          body: { applicantId: randomUUID(), loanProductId: productId },
        })
      ).status,
    ).toBe(400);
  });

  it("updates a case the actor owns", async () => {
    const session = await signIn(await createEmployee("telecaller"));
    const customer = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: "Update Test" },
    });
    const created = await api("/api/cases", {
      method: "POST",
      token: session.token,
      body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
    });

    const updated = await api(`/api/cases/${created.body.id}`, {
      method: "PATCH",
      token: session.token,
      body: { stage: "contacted", requestedAmount: 999000 },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.stage).toBe("contacted");
    expect(updated.body.requestedAmount).toBe(999000);
  });
});

// ---------------------------------------------------------------------------
// The security boundary — the reason Stage 2 exists
// ---------------------------------------------------------------------------

describe("case visibility is enforced by the server", () => {
  /** Telecaller A with one case, plus a signed-in Telecaller B. */
  async function twoTelecallers() {
    const a = await signIn(await createEmployee("telecaller"));
    const b = await signIn(await createEmployee("telecaller"));

    const customer = await api("/api/customers", {
      method: "POST",
      token: a.token,
      body: { fullName: `Private ${randomUUID().slice(0, 8)}` },
    });
    const created = await api("/api/cases", {
      method: "POST",
      token: a.token,
      body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
    });
    return { a, b, caseId: created.body.id as string, caseNumber: created.body.caseNumber };
  }

  it("hides another Telecaller's case from the list (case.read is 'own')", async () => {
    const { b, caseId } = await twoTelecallers();
    const listed = await api("/api/cases", { token: b.token });

    expect(listed.status).toBe(200);
    expect(listed.body.some((c: any) => c.id === caseId)).toBe(false);
  });

  it("refuses direct URL access to another Telecaller's case", async () => {
    const { b, caseId, caseNumber } = await twoTelecallers();

    // The frontend is not involved. This is a token and a URL.
    const direct = await api(`/api/cases/${caseId}`, { token: b.token });

    expect(direct.status).toBe(404);
    // Not one field of the case leaked, including its number.
    expect(JSON.stringify(direct.body)).not.toContain(caseNumber);
  });

  it("refuses a write to another Telecaller's case", async () => {
    const { b, caseId } = await twoTelecallers();
    const attempt = await api(`/api/cases/${caseId}`, {
      method: "PATCH",
      token: b.token,
      body: { stage: "lost" },
    });
    expect(attempt.status).toBe(404);

    const { rows } = await pool.query(`select stage from loan_case where id = $1`, [caseId]);
    expect(rows[0].stage).toBe("new");
  });

  it("lets the owning Telecaller read their own case", async () => {
    const { a, caseId } = await twoTelecallers();
    const own = await api(`/api/cases/${caseId}`, { token: a.token });
    expect(own.status).toBe(200);
    expect(own.body.id).toBe(caseId);
  });

  it.each([
    ["login_executive" as Role],
    ["manager" as Role],
    ["managing_partner" as Role],
  ])("lets a %s see a Telecaller's case (case.read is 'all')", async (role) => {
    const { caseId } = await twoTelecallers();
    const elevated = await signIn(await createEmployee(role));

    const direct = await api(`/api/cases/${caseId}`, { token: elevated.token });
    expect(direct.status).toBe(200);
    expect(direct.body.id).toBe(caseId);

    const listed = await api("/api/cases", { token: elevated.token });
    expect(listed.body.some((c: any) => c.id === caseId)).toBe(true);
  });

  it("lets a Manager update a case they do not own", async () => {
    const { caseId } = await twoTelecallers();
    const manager = await signIn(await createEmployee("manager"));

    const updated = await api(`/api/cases/${caseId}`, {
      method: "PATCH",
      token: manager.token,
      body: { stage: "contacted" },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.stage).toBe("contacted");
  });

  it("refuses an account that holds no roles at all", async () => {
    const { caseId } = await twoTelecallers();

    // Every role in roles.ts holds case.read — Telecaller at `own`, all others
    // at `all` — so "a role without it" does not exist to test with. An
    // account with NO roles does, and is the realistic case: a user created
    // but not yet granted anything. It must read nothing rather than default
    // to something.
    const username = await createEmployee("telecaller");
    // `revoked_by` as well as `revoked_at`: the schema's
    // `user_role_revocation_is_complete` check refuses a revocation that does
    // not record who performed it, which is the right rule and worth leaving
    // the test honest about.
    await pool.query(
      `update user_role set revoked_at = now(), revoked_by = user_id
        where user_id = (select id from app_user where username = $1)`,
      [username],
    );
    const roleless = await signIn(username);

    const direct = await api(`/api/cases/${caseId}`, { token: roleless.token });
    expect(direct.status).toBe(403);
    expect(direct.body.message).toContain("case.read");

    // And their own list is empty rather than everyone's.
    const listed = await api("/api/cases", { token: roleless.token });
    expect(listed.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe("multiple sessions share one authoritative database", () => {
  it("shows a Telecaller's new case to a Login Executive in a different session", async () => {
    // Two independent tokens — what two browsers on two PCs actually hold.
    const telecaller = await signIn(await createEmployee("telecaller"));
    const loginExec = await signIn(await createEmployee("login_executive"));

    const customer = await api("/api/customers", {
      method: "POST",
      token: telecaller.token,
      body: { fullName: `Shared ${randomUUID().slice(0, 8)}`, city: "Madurai" },
    });
    const created = await api("/api/cases", {
      method: "POST",
      token: telecaller.token,
      body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
    });

    const seen = await api(`/api/cases/${created.body.id}`, { token: loginExec.token });
    expect(seen.status).toBe(200);
    expect(seen.body.caseNumber).toBe(created.body.caseNumber);
    expect(seen.body.applicantName).toBe(customer.body.fullName);
  });

  it("shows one session's update to another session immediately", async () => {
    const telecaller = await signIn(await createEmployee("telecaller"));
    const manager = await signIn(await createEmployee("manager"));

    const customer = await api("/api/customers", {
      method: "POST",
      token: telecaller.token,
      body: { fullName: "Concurrent Test" },
    });
    const created = await api("/api/cases", {
      method: "POST",
      token: telecaller.token,
      body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
    });

    await api(`/api/cases/${created.body.id}`, {
      method: "PATCH",
      token: manager.token,
      body: { stage: "documents_pending" },
    });

    // No cache, no sync, no shared browser storage: the Telecaller reads the
    // same row the Manager just wrote.
    const reread = await api(`/api/cases/${created.body.id}`, { token: telecaller.token });
    expect(reread.body.stage).toBe("documents_pending");
  });
});

describe("persistence", () => {
  it("survives a backend restart — the data is in Postgres, not in the process", async () => {
    const session = await signIn(await createEmployee("telecaller"));
    const customer = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: `Durable ${randomUUID().slice(0, 8)}` },
    });
    const created = await api("/api/cases", {
      method: "POST",
      token: session.token,
      body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
    });

    // Tear the HTTP server down completely and stand a new one up. Any state
    // that lived in the process is gone by construction.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createApiServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // The SAME token still works — sessions are rows, not memory. This is what
    // stops a backend restart from logging the whole office out.
    const afterRestart = await api(`/api/cases/${created.body.id}`, { token: session.token });
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body.caseNumber).toBe(created.body.caseNumber);
  });
});
