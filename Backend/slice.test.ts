/**
 * Stage 3B acceptance tests — the widened customer + case slice.
 *
 * Stage 2 proved the architecture with ten case fields and a name. These cover
 * what the frontend actually needs to render the screens it is being migrated
 * onto: identifiers and aliases on a customer, the hold/lost/owner verbs on a
 * case, the reference catalogues that turn ids into words, and search.
 *
 * The stage-machine tests are the ones worth reading. They assert that the
 * server refuses a move the domain forbids — including the move a Stage 2 test
 * used to make in a single PATCH — because the whole reason stage changes got
 * their own route is that a generic field patch was a way past every guard.
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

async function signInAs(role: Role): Promise<Session> {
  const username = await createEmployee(role);
  const { status, body } = await api("/api/auth/login", {
    method: "POST",
    body: { username, password: PASSWORD },
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return { token: body.token, userId: body.user.id, username };
}

async function anyLoanProductId(): Promise<string> {
  const { rows } = await pool.query(`select id from loan_product limit 1`);
  return rows[0]!.id;
}

/** A customer and a case owned by `session`. */
async function aCase(session: Session, name = `Applicant ${randomUUID().slice(0, 8)}`) {
  const customer = await api("/api/customers", {
    method: "POST",
    token: session.token,
    body: { fullName: name, phone: "9843012345", city: "Coimbatore" },
  });
  const created = await api("/api/cases", {
    method: "POST",
    token: session.token,
    body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return { customer: customer.body, loanCase: created.body };
}

async function move(session: Session, caseId: string, stage: string) {
  return await api(`/api/cases/${caseId}/stage`, {
    method: "PUT",
    token: session.token,
    body: { stage },
  });
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

describe("customers carry identifiers and aliases", () => {
  it("creates a customer with a phone in one request", async () => {
    const session = await signInAs("telecaller");
    const created = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: "Ravi Kumar", phone: "98430 12345", locality: "Anna Nagar" },
    });

    expect(created.status).toBe(200);
    const phone = created.body.identifiers.find((i: any) => i.type === "phone");
    expect(phone.isPrimary).toBe(true);
    // What was typed is kept verbatim; matching uses the normalised form.
    expect(phone.value).toBe("98430 12345");
  });

  it("finds a customer by a fragment of their phone number", async () => {
    const session = await signInAs("telecaller");
    const unique = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
    const created = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: `Phone Search ${randomUUID().slice(0, 6)}`, phone: unique },
    });

    // Four digits is how somebody actually searches.
    const found = await api(`/api/customers?q=${unique.slice(-4)}`, { token: session.token });
    expect(found.body.some((c: any) => c.id === created.body.id)).toBe(true);
  });

  it("expires a removed number rather than deleting it", async () => {
    const session = await signInAs("telecaller");
    const created = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: "Number Changer", phone: "9843011111" },
    });

    const replaced = await api(`/api/customers/${created.body.id}/identifiers`, {
      method: "PUT",
      token: session.token,
      body: { identifiers: [{ type: "phone", value: "9843022222", isPrimary: true }] },
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body.identifiers).toHaveLength(1);
    expect(replaced.body.identifiers[0].value).toBe("9843022222");

    // The old number is still on the record, marked expired — a 2024 call must
    // stay attributable to whoever held the number in 2024 (migration 0002).
    const { rows } = await pool.query(
      `select value_raw, valid_to from person_identifier
        where person_id = $1 and value_normalised = '9843011111'`,
      [created.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].valid_to).not.toBeNull();
  });

  it("leaves an unchanged identifier alone when the form is re-saved", async () => {
    const session = await signInAs("telecaller");
    const created = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: "Unchanged", phone: "9843033333" },
    });
    const before = created.body.identifiers[0].id;

    const resaved = await api(`/api/customers/${created.body.id}/identifiers`, {
      method: "PUT",
      token: session.token,
      body: { identifiers: [{ type: "phone", value: "9843033333", isPrimary: true }] },
    });
    expect(resaved.body.identifiers[0].id).toBe(before);
  });

  it("refuses two primaries of the same kind and an unknown type", async () => {
    const session = await signInAs("telecaller");
    const created = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: "Bad Identifiers" },
    });

    const twoPrimaries = await api(`/api/customers/${created.body.id}/identifiers`, {
      method: "PUT",
      token: session.token,
      body: {
        identifiers: [
          { type: "phone", value: "9843044444", isPrimary: true },
          { type: "phone", value: "9843055555", isPrimary: true },
        ],
      },
    });
    expect(twoPrimaries.status).toBe(400);

    const unknown = await api(`/api/customers/${created.body.id}/identifiers`, {
      method: "PUT",
      token: session.token,
      body: { identifiers: [{ type: "passport", value: "X1234567" }] },
    });
    expect(unknown.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe("the stage machine is enforced by the server", () => {
  it("allows the ordinary telecalling path", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    for (const stage of ["contacted", "appointment_fixed", "documents_pending"]) {
      const moved = await move(session, loanCase.id, stage);
      expect(moved.status, `${stage}: ${JSON.stringify(moved.body)}`).toBe(200);
      expect(moved.body.stage).toBe(stage);
    }
  });

  it("refuses a jump the transition table does not allow", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    const jump = await move(session, loanCase.id, "documents_pending");
    expect(jump.status).toBe(409);
    expect(jump.body.message).toContain("cannot move from new to documents_pending");

    const { rows } = await pool.query(`select stage from loan_case where id = $1`, [loanCase.id]);
    expect(rows[0].stage).toBe("new");
  });

  it("refuses a document-driven advance as a system transition", async () => {
    const session = await signInAs("login_executive");
    const { loanCase } = await aCase(session);
    await move(session, loanCase.id, "contacted");
    await move(session, loanCase.id, "documents_pending");

    // `documents_pending` → `ready_for_submission` is a system transition
    // (ADR-019): it happens automatically once requirements are settled, not
    // by a person choosing it from the stage picker. A direct request is
    // refused on the actor check before the (now real, Stage 3C) requirement
    // count is even consulted — see Backend/documents.test.ts for the
    // automatic advance itself.
    const attempt = await move(session, loanCase.id, "ready_for_submission");
    expect(attempt.status).toBe(409);
    expect(attempt.body.message).toContain("system transition");
  });

  it("refuses to reach `lost` as an ordinary stage move", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    const attempt = await move(session, loanCase.id, "lost");
    expect(attempt.status).toBe(400);
    expect(attempt.body.message).toContain("reason");
  });

  it("will not move a case that is on hold", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    await api(`/api/cases/${loanCase.id}/hold`, {
      method: "PUT",
      token: session.token,
      body: { isOnHold: true, holdReason: "Customer travelling until March" },
    });

    const attempt = await move(session, loanCase.id, "contacted");
    expect(attempt.status).toBe(409);
    expect(attempt.body.message).toContain("on hold");
  });
});

describe("hold, loss and reopening", () => {
  it("records a hold with its reason and releases it", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    const held = await api(`/api/cases/${loanCase.id}/hold`, {
      method: "PUT",
      token: session.token,
      body: { isOnHold: true, holdReason: "Waiting on the customer's brother" },
    });
    expect(held.body.isOnHold).toBe(true);
    expect(held.body.holdReason).toBe("Waiting on the customer's brother");

    const released = await api(`/api/cases/${loanCase.id}/hold`, {
      method: "PUT",
      token: session.token,
      body: { isOnHold: false },
    });
    expect(released.body.isOnHold).toBe(false);
    expect(released.body.holdReason).toBeNull();
  });

  it("refuses a hold with no reason — that is just a forgotten case", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    const attempt = await api(`/api/cases/${loanCase.id}/hold`, {
      method: "PUT",
      token: session.token,
      body: { isOnHold: true },
    });
    expect(attempt.status).toBe(400);
  });

  it("marks a case lost with a reason and reopens it where it was", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);
    await move(session, loanCase.id, "contacted");

    const lost = await api(`/api/cases/${loanCase.id}/lost`, {
      method: "PUT",
      token: session.token,
      body: { lostReason: "rate_too_high", lostNote: "Went with HDFC at 8.4%" },
    });
    expect(lost.status).toBe(200);
    expect(lost.body.stage).toBe("lost");
    expect(lost.body.lostReason).toBe("rate_too_high");
    expect(lost.body.stageBeforeLost).toBe("contacted");

    const reopened = await api(`/api/cases/${loanCase.id}/reopen`, {
      method: "POST",
      token: session.token,
    });
    // Back where it was, not back to the beginning — a postponed customer
    // returning does not restart the conversation.
    expect(reopened.body.stage).toBe("contacted");
    expect(reopened.body.lostReason).toBeNull();
  });

  it("refuses a loss with no recorded reason", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    const attempt = await api(`/api/cases/${loanCase.id}/lost`, {
      method: "PUT",
      token: session.token,
      body: { lostNote: "they said no" },
    });
    expect(attempt.status).toBe(400);
  });
});

describe("assignment", () => {
  it("lets a Manager hand a case to someone else", async () => {
    const manager = await signInAs("manager");
    const telecaller = await signInAs("telecaller");
    const { loanCase } = await aCase(telecaller);

    const assigned = await api(`/api/cases/${loanCase.id}/owner`, {
      method: "PUT",
      token: manager.token,
      body: { ownerUserId: manager.userId },
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.ownerUserId).toBe(manager.userId);

    // And the original owner, a Telecaller with `case.read` at `own`, can no
    // longer see it — the scope filter follows ownership.
    const gone = await api(`/api/cases/${loanCase.id}`, { token: telecaller.token });
    expect(gone.status).toBe(404);
  });

  it("refuses a Telecaller assigning their own case away", async () => {
    const telecaller = await signInAs("telecaller");
    const other = await signInAs("telecaller");
    const { loanCase } = await aCase(telecaller);

    const attempt = await api(`/api/cases/${loanCase.id}/owner`, {
      method: "PUT",
      token: telecaller.token,
      body: { ownerUserId: other.userId },
    });
    expect(attempt.status).toBe(403);
    expect(attempt.body.message).toContain("case.assign");
  });

  it("refuses assignment to a deactivated account", async () => {
    const manager = await signInAs("manager");
    const leaver = await signInAs("telecaller");
    const { loanCase } = await aCase(manager);

    await api(`/api/users/${leaver.userId}/active`, {
      method: "PUT",
      token: manager.token,
      body: { isActive: false },
    });

    // Assigning to a deactivated account is how a case becomes nobody's.
    const attempt = await api(`/api/cases/${loanCase.id}/owner`, {
      method: "PUT",
      token: manager.token,
      body: { ownerUserId: leaver.userId },
    });
    expect(attempt.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe("reference data and search", () => {
  it("labels every loan product and lists referral sources", async () => {
    const session = await signInAs("telecaller");
    const reference = await api("/api/reference", { token: session.token });

    expect(reference.status).toBe(200);
    expect(reference.body.loanProducts.length).toBeGreaterThan(0);
    for (const product of reference.body.loanProducts) {
      // Every product renders as words. A case whose product cannot be
      // labelled shows "—" on every screen it appears on.
      expect(product.label).toMatch(/\S · \S/);
    }
    expect(reference.body.referralSources.length).toBeGreaterThan(0);
  });

  it("finds a person by name, alias fragment and locality", async () => {
    const session = await signInAs("telecaller");
    const marker = randomUUID().slice(0, 8);
    const created = await api("/api/customers", {
      method: "POST",
      token: session.token,
      body: { fullName: `Sasirekha ${marker}`, locality: `Peelamedu${marker}` },
    });

    for (const query of [marker, `sasirekha ${marker}`, `Peelamedu${marker}`]) {
      const hits = await api(`/api/search?q=${encodeURIComponent(query)}`, {
        token: session.token,
      });
      expect(
        hits.body.some((h: any) => h.kind === "person" && h.id === created.body.id),
        `no hit for "${query}"`,
      ).toBe(true);
    }
  });

  it("never surfaces another Telecaller's case through search", async () => {
    const owner = await signInAs("telecaller");
    const { loanCase } = await aCase(owner);
    const nosy = await signInAs("telecaller");

    const ownersOwn = await api(`/api/search?q=${loanCase.caseNumber}`, { token: owner.token });
    expect(ownersOwn.body.some((h: any) => h.id === loanCase.id)).toBe(true);

    // Search must not be the hole through which a colleague's caseload leaks —
    // the same scope filter the list uses applies here.
    const colleague = await api(`/api/search?q=${loanCase.caseNumber}`, { token: nosy.token });
    expect(colleague.body.some((h: any) => h.id === loanCase.id)).toBe(false);

    const manager = await signInAs("manager");
    const elevated = await api(`/api/search?q=${loanCase.caseNumber}`, { token: manager.token });
    expect(elevated.body.some((h: any) => h.id === loanCase.id)).toBe(true);
  });

  it("lists a person's cases, scoped to what the actor may see", async () => {
    const owner = await signInAs("telecaller");
    const { customer, loanCase } = await aCase(owner);

    const own = await api(`/api/customers/${customer.id}/cases`, { token: owner.token });
    expect(own.body.map((c: any) => c.id)).toContain(loanCase.id);
    expect(own.body[0].partyRole).toBe("applicant");

    const nosy = await signInAs("telecaller");
    const theirs = await api(`/api/customers/${customer.id}/cases`, { token: nosy.token });
    // The customer is visible to everyone — recognition is the point — but
    // the colleague's case on them is not.
    expect(theirs.status).toBe(200);
    expect(theirs.body).toHaveLength(0);
  });
});

describe("the signed-in employee's own overrides reach the browser", () => {
  it("returns them on /api/auth/me so the UI and the server agree", async () => {
    const admin = await signInAs("managing_partner");
    const telecaller = await signInAs("telecaller");

    const before = await api("/api/auth/me", { token: telecaller.token });
    expect(before.body.overrides).toEqual([]);

    await api(`/api/users/${telecaller.userId}/overrides`, {
      method: "POST",
      token: admin.token,
      body: { permission: "case.read", scope: "all", decision: "grant" },
    });

    const after = await api("/api/auth/me", { token: telecaller.token });
    // Without this the browser would compute permissions from roles alone and
    // hide a button the server would have honoured.
    expect(after.body.overrides).toEqual([
      { permission: "case.read", scope: "all", decision: "grant" },
    ]);
  });
});
