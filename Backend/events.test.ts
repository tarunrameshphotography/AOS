/**
 * Stage 3C-0 acceptance — customer and case mutations append to the audit log.
 *
 * THE DEBT THIS PAYS. Stage 2 wrote no events and said so. Stage 3A added them
 * for administrative actions only. Stage 3B migrated the customer and case
 * slice and carried the gap forward, which meant AOS had a case screen backed
 * by PostgreSQL and no record of who had moved anything on it. BR-050 says a
 * state change and its event are written in the same transaction or the change
 * does not happen; these tests are what makes that claim checkable.
 *
 * THREE THINGS ARE ASSERTED, and only the first is obvious:
 *
 *   1. Meaningful mutations produce the right event, naming the right actor.
 *   2. A mutation that changes nothing produces NO event. The screens submit
 *      whole forms and browsers retry requests; an audit log that grows every
 *      time somebody presses Save without editing anything cannot be read.
 *   3. A failed transaction leaves neither the change nor the event. Not the
 *      event alone, and not the change alone.
 *
 * NO PERSONAL DATA IN PAYLOADS is asserted too, because it is the rule most
 * easily broken by a well-meaning later change: the log is never redacted
 * (BR-051), so a name that gets into it cannot be taken out (ADR-018).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { hashPassword } from "@domain/auth/password.js";
import type { Role } from "@domain/permissions/index.js";

import { createApiServer } from "./api-server.js";
import { pool, withActor } from "./db.js";
import { updateCase } from "./cases.js";
import type { Actor } from "./authorize.js";

let baseUrl: string;
let server: ReturnType<typeof createApiServer>;

const PASSWORD = "integration-test-password";

interface Session {
  readonly token: string;
  readonly userId: string;
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
  return { token: body.token, userId: body.user.id };
}

async function anyLoanProductId(): Promise<string> {
  const { rows } = await pool.query(`select id from loan_product limit 1`);
  return rows[0]!.id;
}

interface EventRow {
  readonly event_type: string;
  readonly actor_kind: string;
  readonly actor_user_id: string | null;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly case_id: string | null;
  readonly payload_before: Record<string, unknown> | null;
  readonly payload_after: Record<string, unknown> | null;
}

/** Every event recorded against one entity, oldest first. */
async function eventsFor(entityId: string): Promise<EventRow[]> {
  const { rows } = await pool.query(
    `select event_type, actor_kind, actor_user_id, entity_type, entity_id, case_id,
            payload_before, payload_after
       from event where entity_id = $1 order by id`,
    [entityId],
  );
  return rows;
}

async function eventTypesFor(entityId: string): Promise<string[]> {
  return (await eventsFor(entityId)).map((row) => row.event_type);
}

async function aCustomer(session: Session, fullName: string, phone = "9843012345") {
  const { status, body } = await api("/api/customers", {
    method: "POST",
    token: session.token,
    body: { fullName, phone, city: "Coimbatore" },
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return body;
}

async function aCase(session: Session) {
  const customer = await aCustomer(session, `Applicant ${randomUUID().slice(0, 8)}`);
  const { status, body } = await api("/api/cases", {
    method: "POST",
    token: session.token,
    body: {
      applicantId: customer.id,
      loanProductId: await anyLoanProductId(),
      requestedAmount: 3_500_000,
    },
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return { customer, loanCase: body };
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

describe("customer mutations are recorded", () => {
  it("records who created a customer, without recording who they are", async () => {
    const session = await signInAs("telecaller");
    const customer = await aCustomer(session, "Ravi Subramanian Auditable");

    const events = await eventsFor(customer.id);
    expect(events.map((e) => e.event_type)).toEqual(["person.created"]);

    const created = events[0]!;
    expect(created.actor_kind).toBe("user");
    expect(created.actor_user_id).toBe(session.userId);
    expect(created.entity_type).toBe("person");
    // A person is not owned by a case — their history belongs to their profile.
    expect(created.case_id).toBeNull();

    // Field names, not values. The name and the number are in `person` and
    // `person_identifier`, where erasure can reach them.
    const payload = JSON.stringify(created.payload_after);
    expect(payload).not.toContain("Ravi");
    expect(payload).not.toContain("9843012345");
    expect(created.payload_after).toMatchObject({ identifierTypes: ["phone"] });
  });

  it("records an edit, naming the fields that changed and nothing else", async () => {
    const session = await signInAs("telecaller");
    const customer = await aCustomer(session, "Edited Customer");

    const { status } = await api(`/api/customers/${customer.id}`, {
      method: "PATCH",
      token: session.token,
      body: { locality: "Peelamedu", pincode: "641004" },
    });
    expect(status).toBe(200);

    const events = await eventsFor(customer.id);
    expect(events.map((e) => e.event_type)).toEqual(["person.created", "person.updated"]);
    expect(events[1]!.payload_after).toEqual({ changedFields: ["locality", "pincode"] });
    expect(JSON.stringify(events[1]!.payload_after)).not.toContain("Peelamedu");
  });

  it("writes nothing when the same values are submitted again", async () => {
    const session = await signInAs("telecaller");
    const customer = await aCustomer(session, "Unchanged Customer");

    await api(`/api/customers/${customer.id}`, {
      method: "PATCH",
      token: session.token,
      body: { locality: "Gandhipuram" },
    });
    expect(await eventTypesFor(customer.id)).toEqual(["person.created", "person.updated"]);

    // The same request again — a double-click, or a browser retrying after a
    // dropped connection. It must not read as a second edit.
    const repeat = await api(`/api/customers/${customer.id}`, {
      method: "PATCH",
      token: session.token,
      body: { locality: "Gandhipuram" },
    });
    expect(repeat.status).toBe(200);
    expect(repeat.body.locality).toBe("Gandhipuram");
    expect(await eventTypesFor(customer.id)).toEqual(["person.created", "person.updated"]);
  });

  it("records an identifier change by id and type, never by value", async () => {
    const session = await signInAs("telecaller");
    const customer = await aCustomer(session, "Contactable Customer");

    const changed = await api(`/api/customers/${customer.id}/identifiers`, {
      method: "PUT",
      token: session.token,
      body: {
        identifiers: [
          { type: "phone", value: "9843099999", isPrimary: true },
          { type: "email", value: "someone@example.com" },
        ],
      },
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    const events = await eventsFor(customer.id);
    expect(events.map((e) => e.event_type)).toEqual([
      "person.created",
      "person.identifier_updated",
    ]);

    const payload = JSON.stringify(events[1]!.payload_after);
    expect(payload).not.toContain("9843012345");
    expect(payload).not.toContain("9843099999");
    expect(payload).not.toContain("someone@example.com");
    expect(events[1]!.payload_after).toMatchObject({
      added: [{ type: "phone" }, { type: "email" }],
    });

    // Re-submitting the identical list changes nothing and records nothing.
    await api(`/api/customers/${customer.id}/identifiers`, {
      method: "PUT",
      token: session.token,
      body: {
        identifiers: [
          { type: "phone", value: "9843099999", isPrimary: true },
          { type: "email", value: "someone@example.com" },
        ],
      },
    });
    expect(await eventTypesFor(customer.id)).toEqual([
      "person.created",
      "person.identifier_updated",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("case mutations are recorded", () => {
  it("records the creation, on the case's own timeline", async () => {
    const session = await signInAs("telecaller");
    const { loanCase, customer } = await aCase(session);

    const events = await eventsFor(loanCase.id);
    expect(events.map((e) => e.event_type)).toEqual(["case.created"]);

    const created = events[0]!;
    expect(created.entity_type).toBe("case");
    // `case_id` as well as `entity_id`: the case timeline is built on it.
    expect(created.case_id).toBe(loanCase.id);
    expect(created.actor_user_id).toBe(session.userId);
    expect(created.payload_after).toMatchObject({
      stage: "new",
      ownerUserId: session.userId,
      applicantId: customer.id,
    });
  });

  it("records a stage move, from and to", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    const moved = await api(`/api/cases/${loanCase.id}/stage`, {
      method: "PUT",
      token: session.token,
      body: { stage: "contacted" },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);

    const events = await eventsFor(loanCase.id);
    expect(events.map((e) => e.event_type)).toEqual(["case.created", "case.stage_changed"]);
    expect(events[1]!.payload_before).toEqual({ stage: "new" });
    expect(events[1]!.payload_after).toEqual({ stage: "contacted" });
  });

  it("records a hold and its release, and keeps the free-text reason out of the log", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    await api(`/api/cases/${loanCase.id}/hold`, {
      method: "PUT",
      token: session.token,
      body: { isOnHold: true, holdReason: "Ravi's brother says wait for his salary" },
    });
    await api(`/api/cases/${loanCase.id}/hold`, {
      method: "PUT",
      token: session.token,
      body: { isOnHold: false },
    });

    const events = await eventsFor(loanCase.id);
    expect(events.map((e) => e.event_type)).toEqual([
      "case.created",
      "case.held",
      "case.hold_lifted",
    ]);
    // The sentence stays on `loan_case`, where redaction can reach it.
    expect(JSON.stringify(events[1]!.payload_after)).not.toContain("Ravi");
  });

  it("writes nothing when a hold is placed twice or released twice", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    // Not on hold, and asked to come off hold: a no-op.
    await api(`/api/cases/${loanCase.id}/hold`, {
      method: "PUT",
      token: session.token,
      body: { isOnHold: false },
    });
    expect(await eventTypesFor(loanCase.id)).toEqual(["case.created"]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await api(`/api/cases/${loanCase.id}/hold`, {
        method: "PUT",
        token: session.token,
        body: { isOnHold: true, holdReason: "Waiting on the valuation" },
      });
    }
    expect(await eventTypesFor(loanCase.id)).toEqual(["case.created", "case.held"]);
  });

  it("records loss with its reason code, and the reopen that follows", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    await api(`/api/cases/${loanCase.id}/stage`, {
      method: "PUT",
      token: session.token,
      body: { stage: "contacted" },
    });
    const lost = await api(`/api/cases/${loanCase.id}/lost`, {
      method: "PUT",
      token: session.token,
      body: { lostReason: "not_interested", lostNote: "Ravi changed his mind" },
    });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);

    const reopened = await api(`/api/cases/${loanCase.id}/reopen`, {
      method: "POST",
      token: session.token,
    });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);

    const events = await eventsFor(loanCase.id);
    expect(events.map((e) => e.event_type)).toEqual([
      "case.created",
      "case.stage_changed",
      "case.marked_lost",
      "case.reopened",
    ]);
    expect(events[2]!.payload_after).toEqual({
      stage: "lost",
      lostReason: "not_interested",
    });
    // The note is free text about a named person and never reaches the log.
    expect(JSON.stringify(events[2]!.payload_after)).not.toContain("Ravi");
    expect(events[3]!.payload_after).toEqual({ stage: "contacted" });
  });

  it("records a reassignment, naming the manager who made it", async () => {
    const owner = await signInAs("telecaller");
    const manager = await signInAs("manager");
    const { loanCase } = await aCase(owner);

    const assigned = await api(`/api/cases/${loanCase.id}/owner`, {
      method: "PUT",
      token: manager.token,
      body: { ownerUserId: manager.userId },
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

    const events = await eventsFor(loanCase.id);
    expect(events.map((e) => e.event_type)).toEqual(["case.created", "case.assigned"]);
    // The actor is the manager who reassigned it, not the telecaller who owns it.
    expect(events[1]!.actor_user_id).toBe(manager.userId);
    expect(events[1]!.payload_before).toEqual({ ownerUserId: owner.userId });
    expect(events[1]!.payload_after).toEqual({ ownerUserId: manager.userId });

    // Assigning to the same person again is not a second handover.
    await api(`/api/cases/${loanCase.id}/owner`, {
      method: "PUT",
      token: manager.token,
      body: { ownerUserId: manager.userId },
    });
    expect(await eventTypesFor(loanCase.id)).toEqual(["case.created", "case.assigned"]);
  });

  it("records a field edit, and nothing when the same value is saved again", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);

    await api(`/api/cases/${loanCase.id}`, {
      method: "PATCH",
      token: session.token,
      body: { requestedAmount: 7_250_000 },
    });
    const events = await eventsFor(loanCase.id);
    expect(events.map((e) => e.event_type)).toEqual(["case.created", "case.facts_updated"]);
    expect(events[1]!.payload_after).toEqual({ requestedAmount: 7250000 });

    // `numeric` comes back from the driver as a string; the same amount
    // submitted as a number must still count as unchanged.
    const repeat = await api(`/api/cases/${loanCase.id}`, {
      method: "PATCH",
      token: session.token,
      body: { requestedAmount: 7_250_000 },
    });
    expect(repeat.status).toBe(200);
    expect(await eventTypesFor(loanCase.id)).toEqual(["case.created", "case.facts_updated"]);
  });
});

// ---------------------------------------------------------------------------

describe("a mutation and its event share one transaction", () => {
  it("leaves neither the change nor the event when the transaction fails", async () => {
    const session = await signInAs("telecaller");
    const { loanCase } = await aCase(session);
    const before = (await eventTypesFor(loanCase.id)).length;

    const actor: Actor = {
      userId: session.userId,
      authIdentityId: randomUUID(),
      roles: ["telecaller"],
      overrides: [],
    };

    // The handler is called exactly as the API server calls it — inside
    // `withActor`'s transaction — and then the request fails after it, the way
    // a later step in a longer handler would. BR-050 says neither half
    // survives that.
    await expect(
      withActor(null, async (client) => {
        await updateCase(client, actor, loanCase.id, { requestedAmount: 9_999_999 });
        throw new Error("something later in the request went wrong");
      }),
    ).rejects.toThrow("something later in the request went wrong");

    const { rows } = await pool.query(`select requested_amount from loan_case where id = $1`, [
      loanCase.id,
    ]);
    expect(Number(rows[0]!.requested_amount)).toBe(3_500_000);
    expect((await eventTypesFor(loanCase.id)).length).toBe(before);
  });

  it("writes no event for a mutation the server refused", async () => {
    const owner = await signInAs("telecaller");
    const stranger = await signInAs("telecaller");
    const { loanCase } = await aCase(owner);

    // A colleague's case: refused, and silent in the log.
    const refused = await api(`/api/cases/${loanCase.id}/stage`, {
      method: "PUT",
      token: stranger.token,
      body: { stage: "contacted" },
    });
    expect(refused.status).toBe(404);

    // And a move the domain forbids.
    const forbidden = await api(`/api/cases/${loanCase.id}/stage`, {
      method: "PUT",
      token: owner.token,
      body: { stage: "documents_pending" },
    });
    expect(forbidden.status).toBe(409);

    expect(await eventTypesFor(loanCase.id)).toEqual(["case.created"]);
  });
});
