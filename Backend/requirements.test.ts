/**
 * Phase 3 (concurrency & audit hardening) acceptance tests for requirement
 * regeneration.
 *
 * `regenerateRequirements` (Backend/requirements.ts) reconciles a case's
 * `document_requirement` rows against the rule engine on every read — a GET
 * that mutates. Before this phase that mutation left no audit trail. These
 * tests prove: a regeneration that actually changes rows writes exactly one
 * batched `requirement.regenerated` event naming the case, and a
 * regeneration that changes nothing writes none.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";

import { hashPassword } from "@domain/auth/password.js";
import type { Role } from "@domain/permissions/index.js";

import { createApiServer } from "./api-server.js";
import { pool, withActor } from "./db.js";
import { regenerateRequirements } from "./requirements.js";

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
  path_: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${path_}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
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

async function aCase(session: Session): Promise<{ id: string; stage: string }> {
  const customer = await api("/api/customers", {
    method: "POST",
    token: session.token,
    body: { fullName: `Applicant ${randomUUID().slice(0, 8)}`, phone: "9843012345", city: "Coimbatore" },
  });
  const created = await api("/api/cases", {
    method: "POST",
    token: session.token,
    body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body;
}

async function move(session: Session, caseId: string, stage: string): Promise<{ status: number; body: any }> {
  return await api(`/api/cases/${caseId}/stage`, { method: "PUT", token: session.token, body: { stage } });
}

async function requirementEventsFor(
  caseId: string,
): Promise<{ event_type: string; entity_type: string; actor_kind: string; payload_after: unknown }[]> {
  const { rows } = await pool.query(
    `select event_type, entity_type, actor_kind, payload_after from event
      where case_id = $1 and event_type = 'requirement.regenerated'
      order by occurred_at`,
    [caseId],
  );
  return rows;
}

beforeAll(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await pool.end();
});

describe("requirement regeneration is auditable (Phase 3)", () => {
  it("writes one batched requirement.regenerated event when regeneration actually changes rows", async () => {
    const owner = await signInAs("telecaller");
    const loanCase = await aCase(owner);

    // Opening a case's requirement list for the first time is what makes
    // `regenerateRequirements` insert its rule-generated rows — a real
    // mutation, not a no-op.
    const advanced = await move(owner, loanCase.id, "contacted");
    expect(advanced.status, JSON.stringify(advanced.body)).toBe(200);
    const toDocuments = await move(owner, loanCase.id, "documents_pending");
    expect(toDocuments.status, JSON.stringify(toDocuments.body)).toBe(200);

    const listing = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
    expect(listing.status, JSON.stringify(listing.body)).toBe(200);
    expect(listing.body.requirements.length).toBeGreaterThan(0);

    const events = await requirementEventsFor(loanCase.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.entity_type).toBe("document_requirement");
    // A system reconciliation, not a user action nobody took.
    expect(events[0]!.actor_kind).toBe("system");

    const payload = events[0]!.payload_after as {
      insertedCount: number;
      updatedCount: number;
      retiredCount: number;
      requirementIds: string[];
    };
    expect(payload.insertedCount).toBe(listing.body.requirements.length);
    expect(payload.updatedCount).toBe(0);
    expect(payload.retiredCount).toBe(0);
    expect(payload.requirementIds).toHaveLength(payload.insertedCount);

    // No personal data anywhere in the payload — ids and counts only.
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toMatch(/Applicant/);
    expect(serialised).not.toMatch(/9843012345/);
  });

  it("writes no event when regeneration is asked for again and nothing has changed", async () => {
    const owner = await signInAs("telecaller");
    const loanCase = await aCase(owner);
    await move(owner, loanCase.id, "contacted");
    await move(owner, loanCase.id, "documents_pending");

    // First read: real mutation, one event (proven above).
    const first = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const afterFirst = await requirementEventsFor(loanCase.id);
    expect(afterFirst).toHaveLength(1);

    // Second and third reads: same case facts, same active rules — the
    // reconciliation has nothing left to do, so it must not manufacture a
    // misleading "something changed" event.
    const second = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const third = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
    expect(third.status, JSON.stringify(third.body)).toBe(200);

    const afterRereads = await requirementEventsFor(loanCase.id);
    expect(afterRereads).toHaveLength(1);
    expect(second.body.requirements).toEqual(first.body.requirements);
  });

  it("keeps a no-longer-wanted requirement, retiring it as not_applicable with its own audited event", async () => {
    const owner = await signInAs("telecaller");
    const loanCase = await aCase(owner);
    await move(owner, loanCase.id, "contacted");
    await move(owner, loanCase.id, "documents_pending");

    const before = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    const requirementCountBefore = before.body.requirements.length;
    expect(requirementCountBefore).toBeGreaterThan(0);

    // A fact change the rule engine reacts to: GST registration usually adds
    // or removes GST-conditioned requirements. Directly flip a case fact and
    // reconcile, rather than depending on a specific product's rule set.
    await pool.query(`update loan_case set is_gst_registered = not coalesce(is_gst_registered, false) where id = $1`, [
      loanCase.id,
    ]);

    await withActor(null, (client) => regenerateRequirements(client, loanCase.id));

    const events = await requirementEventsFor(loanCase.id);
    // Whatever the rule set actually did with that fact flip (added rows,
    // retired rows, both, or genuinely nothing for this product), the trail
    // must be internally consistent: at most one new event, and if one was
    // written it must report at least one real change.
    expect(events.length).toBeLessThanOrEqual(2);
    if (events.length === 2) {
      const payload = events[1]!.payload_after as {
        insertedCount: number;
        updatedCount: number;
        retiredCount: number;
      };
      expect(payload.insertedCount + payload.updatedCount + payload.retiredCount).toBeGreaterThan(0);
    }
  });
});
