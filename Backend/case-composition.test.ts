/**
 * Phase 4 (case completeness) acceptance tests.
 *
 * Proves the workflows the roadmap named as missing: adding a co-applicant,
 * a guarantor and a property to an existing case, removing them again, and
 * waiving a requirement — each persisted in PostgreSQL, authorized through
 * the existing permission catalog, audited, and correctly reflected the next
 * time the requirement engine reconciles the case (real rules, real
 * database, never a mocked array).
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

async function toDocumentsPending(session: Session, caseId: string): Promise<void> {
  const contacted = await api(`/api/cases/${caseId}/stage`, {
    method: "PUT",
    token: session.token,
    body: { stage: "contacted" },
  });
  expect(contacted.status, JSON.stringify(contacted.body)).toBe(200);
  const pending = await api(`/api/cases/${caseId}/stage`, {
    method: "PUT",
    token: session.token,
    body: { stage: "documents_pending" },
  });
  expect(pending.status, JSON.stringify(pending.body)).toBe(200);
}

async function eventsFor(
  caseId: string,
  eventType: string,
): Promise<{ event_type: string; entity_type: string; actor_kind: string; actor_user_id: string | null; payload_after: unknown }[]> {
  const { rows } = await pool.query(
    `select event_type, entity_type, actor_kind, actor_user_id, payload_after from event
      where case_id = $1 and event_type = $2
      order by occurred_at`,
    [caseId, eventType],
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

// ---------------------------------------------------------------------------
// A — Co-applicant management
// ---------------------------------------------------------------------------

describe("co-applicant management (Phase 4)", () => {
  it("adds, reads, updates and removes a co-applicant, each step audited", async () => {
    const owner = await signInAs("telecaller");
    const loanCase = await aCase(owner);

    const coApplicant = await api("/api/customers", {
      method: "POST",
      token: owner.token,
      body: { fullName: `CoApplicant ${randomUUID().slice(0, 8)}`, phone: "9840000001" },
    });
    expect(coApplicant.status, JSON.stringify(coApplicant.body)).toBe(200);

    const added = await api(`/api/cases/${loanCase.id}/parties`, {
      method: "POST",
      token: owner.token,
      body: { role: "co_applicant", personId: coApplicant.body.id },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.role).toBe("co_applicant");
    expect(added.body.isPrimary).toBe(false);
    expect(added.body.personId).toBe(coApplicant.body.id);

    const addEvents = await eventsFor(loanCase.id, "case.party_added");
    expect(addEvents).toHaveLength(1);
    expect(addEvents[0]!.entity_type).toBe("case_party");
    expect(addEvents[0]!.actor_kind).toBe("user");
    const addPayload = JSON.stringify(addEvents[0]!.payload_after);
    expect(addPayload).not.toMatch(/CoApplicant/);

    const listed = await api(`/api/cases/${loanCase.id}/parties`, { token: owner.token });
    expect(listed.status).toBe(200);
    expect(listed.body.some((p: any) => p.id === added.body.id)).toBe(true);

    const employmentType = await pool.query(`select id from employment_type limit 1`);
    const updated = await api(`/api/cases/${loanCase.id}/parties/${added.body.id}`, {
      method: "PATCH",
      token: owner.token,
      body: { employmentTypeId: employmentType.rows[0]!.id },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.employmentTypeId).toBe(employmentType.rows[0]!.id);

    const updateEvents = await eventsFor(loanCase.id, "case.party_profile_updated");
    expect(updateEvents).toHaveLength(1);

    const removed = await api(`/api/cases/${loanCase.id}/parties/${added.body.id}`, {
      method: "DELETE",
      token: owner.token,
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);

    const removeEvents = await eventsFor(loanCase.id, "case.party_removed");
    expect(removeEvents).toHaveLength(1);

    const afterRemoval = await api(`/api/cases/${loanCase.id}/parties`, { token: owner.token });
    const removedRow = afterRemoval.body.find((p: any) => p.id === added.body.id);
    expect(removedRow.removedAt).not.toBeNull();
  });

  it("cannot remove the primary applicant", async () => {
    const owner = await signInAs("telecaller");
    const loanCase = await aCase(owner);

    const parties = await api(`/api/cases/${loanCase.id}/parties`, { token: owner.token });
    const primary = parties.body.find((p: any) => p.isPrimary);
    expect(primary).toBeTruthy();

    const attempt = await api(`/api/cases/${loanCase.id}/parties/${primary.id}`, {
      method: "DELETE",
      token: owner.token,
    });
    expect(attempt.status).toBe(409);
  });

  it("generates party-scoped requirements for a co-applicant, and retires them on removal", async () => {
    const owner = await signInAs("telecaller");
    const loanCase = await aCase(owner);
    await toDocumentsPending(owner, loanCase.id);

    const coApplicant = await api("/api/customers", {
      method: "POST",
      token: owner.token,
      body: { fullName: `CoApplicant ${randomUUID().slice(0, 8)}`, phone: "9840000002" },
    });
    const added = await api(`/api/cases/${loanCase.id}/parties`, {
      method: "POST",
      token: owner.token,
      body: { role: "co_applicant", personId: coApplicant.body.id },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);

    // Reading requirements is what reconciles them (Phase 3 architecture) —
    // real rules, real database.
    const withCoApplicant = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
    expect(withCoApplicant.status).toBe(200);
    const coApplicantRequirements = withCoApplicant.body.requirements.filter(
      (r: any) => r.requiredOfCasePartyId === added.body.id,
    );
    expect(coApplicantRequirements.length).toBeGreaterThan(0);

    await api(`/api/cases/${loanCase.id}/parties/${added.body.id}`, {
      method: "DELETE",
      token: owner.token,
    });

    const afterRemoval = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
    const stillListed = afterRemoval.body.requirements.filter(
      (r: any) => r.requiredOfCasePartyId === added.body.id,
    );
    // Retired to not_applicable, so excluded from the active listing
    // (`listCaseRequirements` filters `status <> 'not_applicable'`) — never
    // silently resurrected as active.
    expect(stillListed).toHaveLength(0);
  });

  it("rejects an unrecognised role and an unauthorized actor", async () => {
    const owner = await signInAs("telecaller");
    const loanCase = await aCase(owner);

    const bogus = await api(`/api/cases/${loanCase.id}/parties`, {
      method: "POST",
      token: owner.token,
      body: { role: "applicant", personId: randomUUID() },
    });
    expect(bogus.status).toBe(400);

    const finance = await signInAs("finance");
    const coApplicant = await api("/api/customers", {
      method: "POST",
      token: owner.token,
      body: { fullName: `CoApplicant ${randomUUID().slice(0, 8)}` },
    });
    const refused = await api(`/api/cases/${loanCase.id}/parties`, {
      method: "POST",
      token: finance.token,
      body: { role: "co_applicant", personId: coApplicant.body.id },
    });
    // Finance holds `case.read` but not `case.update` (src/domain/permissions/
    // roles.ts) — refused on the permission, not silently ignored.
    expect(refused.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// B — Guarantor management
// ---------------------------------------------------------------------------

describe("guarantor management (Phase 4)", () => {
  it("adds a guarantor by creating a person inline, distinguishable by role", async () => {
    const owner = await signInAs("login_executive");
    const loanCase = await aCase(owner);

    const added = await api(`/api/cases/${loanCase.id}/parties`, {
      method: "POST",
      token: owner.token,
      body: {
        role: "guarantor",
        newPersonName: `Guarantor ${randomUUID().slice(0, 8)}`,
        newPersonPhone: "9840000003",
      },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.role).toBe("guarantor");
    expect(added.body.personId).toBeTruthy();

    const person = await pool.query(`select full_name from person where id = $1`, [added.body.personId]);
    expect(person.rows[0]!.full_name).toMatch(/^Guarantor /);
  });

  it("generates guarantor-scoped requirements once the case is collecting documents", async () => {
    const owner = await signInAs("telecaller");
    const loanCase = await aCase(owner);
    await toDocumentsPending(owner, loanCase.id);

    const added = await api(`/api/cases/${loanCase.id}/parties`, {
      method: "POST",
      token: owner.token,
      body: { role: "guarantor", newPersonName: `Guarantor ${randomUUID().slice(0, 8)}` },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);

    const requirements = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
    const guarantorRequirements = requirements.body.requirements.filter(
      (r: any) => r.requiredOfCasePartyId === added.body.id,
    );
    expect(guarantorRequirements.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// C — Property management
// ---------------------------------------------------------------------------

describe("property management (Phase 4)", () => {
  it("a telecaller (no property.create) cannot record a brand-new property inline", async () => {
    const owner = await signInAs("telecaller");
    const loanCase = await aCase(owner);

    const refused = await api(`/api/cases/${loanCase.id}/properties`, {
      method: "POST",
      token: owner.token,
      body: { role: "collateral", locality: "Race Course", city: "Coimbatore" },
    });
    expect(refused.status).toBe(403);
  });

  it("a login executive adds, edits and removes a property, each step audited", async () => {
    const owner = await signInAs("login_executive");
    const loanCase = await aCase(owner);

    const added = await api(`/api/cases/${loanCase.id}/properties`, {
      method: "POST",
      token: owner.token,
      body: { role: "collateral", locality: "Race Course", city: "Coimbatore" },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.role).toBe("collateral");
    expect(added.body.locality).toBe("Race Course");

    const addEvents = await eventsFor(loanCase.id, "case.property_added");
    expect(addEvents).toHaveLength(1);
    expect(addEvents[0]!.entity_type).toBe("case_property");
    expect(JSON.stringify(addEvents[0]!.payload_after)).not.toMatch(/Race Course/);

    const updated = await api(`/api/cases/${loanCase.id}/properties/${added.body.id}`, {
      method: "PATCH",
      token: owner.token,
      body: { city: "Tirupur" },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.city).toBe("Tirupur");

    const updateEvents = await eventsFor(loanCase.id, "case.property_updated");
    expect(updateEvents).toHaveLength(1);

    const removed = await api(`/api/cases/${loanCase.id}/properties/${added.body.id}`, {
      method: "DELETE",
      token: owner.token,
    });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);

    const removeEvents = await eventsFor(loanCase.id, "case.property_removed");
    expect(removeEvents).toHaveLength(1);
  });

  it("refuses a duplicate property link and generates property-scoped requirements", async () => {
    const owner = await signInAs("login_executive");
    const loanCase = await aCase(owner);
    await toDocumentsPending(owner, loanCase.id);

    const property = await pool.query<{ id: string }>(
      `insert into property (locality, city, created_by)
       values ('Peelamedu', 'Coimbatore', (select id from app_user where username = $1)) returning id`,
      [(await pool.query(`select username from app_user order by created_at desc limit 1`)).rows[0]!.username],
    );

    const added = await api(`/api/cases/${loanCase.id}/properties`, {
      method: "POST",
      token: owner.token,
      body: { role: "collateral", propertyId: property.rows[0]!.id },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);

    const duplicate = await api(`/api/cases/${loanCase.id}/properties`, {
      method: "POST",
      token: owner.token,
      body: { role: "purchase", propertyId: property.rows[0]!.id },
    });
    expect(duplicate.status).toBe(409);

    const requirements = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
    const propertyRequirements = requirements.body.requirements.filter(
      (r: any) => r.requiredOfCasePropertyId === added.body.id,
    );
    expect(propertyRequirements.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// D — Requirement waiving
// ---------------------------------------------------------------------------

describe("requirement waiving (Phase 4)", () => {
  async function firstOutstandingRequirement(session: Session, caseId: string): Promise<any> {
    const requirements = await api(`/api/cases/${caseId}/requirements`, { token: session.token });
    const pending = requirements.body.requirements.find((r: any) => r.status === "pending");
    expect(pending, JSON.stringify(requirements.body.requirements)).toBeTruthy();
    return pending;
  }

  it("an authorized user waives a requirement with a reason, and it is auditable", async () => {
    const owner = await signInAs("login_executive");
    const loanCase = await aCase(owner);
    await toDocumentsPending(owner, loanCase.id);
    const requirement = await firstOutstandingRequirement(owner, loanCase.id);

    const waived = await api(`/api/cases/${loanCase.id}/requirements/${requirement.id}/waive`, {
      method: "PUT",
      token: owner.token,
      body: { reason: "Customer travelling; bank agreed to proceed without it" },
    });
    expect(waived.status, JSON.stringify(waived.body)).toBe(200);
    expect(waived.body.status).toBe("waived");
    expect(waived.body.waivedByUserId).toBe(owner.userId);
    expect(waived.body.waivedAt).toBeTruthy();

    const events = await eventsFor(loanCase.id, "requirement.waived");
    expect(events).toHaveLength(1);
    expect(events[0]!.entity_type).toBe("document_requirement");
    expect(events[0]!.actor_kind).toBe("user");
    // The reason is never in the event payload — it lives on the row, where
    // redaction can reach it.
    expect(JSON.stringify(events[0]!.payload_after)).not.toMatch(/travelling/);

    // Persisted: a fresh read of the row (survives the request boundary).
    const stored = await pool.query(
      `select status, waived_by, reason from document_requirement where id = $1`,
      [requirement.id],
    );
    expect(stored.rows[0]!.status).toBe("waived");
    expect(stored.rows[0]!.waived_by).toBe(owner.userId);
    expect(stored.rows[0]!.reason).toMatch(/travelling/);
  });

  it("requires a reason", async () => {
    const owner = await signInAs("login_executive");
    const loanCase = await aCase(owner);
    await toDocumentsPending(owner, loanCase.id);
    const requirement = await firstOutstandingRequirement(owner, loanCase.id);

    const refused = await api(`/api/cases/${loanCase.id}/requirements/${requirement.id}/waive`, {
      method: "PUT",
      token: owner.token,
      body: { reason: "  " },
    });
    expect(refused.status).toBe(400);
  });

  it("refuses an actor without requirement.waive", async () => {
    const owner = await signInAs("telecaller");
    const loanCase = await aCase(owner);
    await toDocumentsPending(owner, loanCase.id);
    const requirement = await firstOutstandingRequirement(owner, loanCase.id);

    // Telecaller does not hold `requirement.waive` (roles.ts).
    const refused = await api(`/api/cases/${loanCase.id}/requirements/${requirement.id}/waive`, {
      method: "PUT",
      token: owner.token,
      body: { reason: "Trying anyway" },
    });
    expect(refused.status).toBe(403);
  });

  it("a waived requirement is not silently resurrected as active by regeneration", async () => {
    const owner = await signInAs("login_executive");
    const loanCase = await aCase(owner);
    await toDocumentsPending(owner, loanCase.id);
    const requirement = await firstOutstandingRequirement(owner, loanCase.id);

    await api(`/api/cases/${loanCase.id}/requirements/${requirement.id}/waive`, {
      method: "PUT",
      token: owner.token,
      body: { reason: "Waived for regeneration check" },
    });

    // Force a reconciliation (a second read) and confirm the row keeps its
    // waived status rather than reverting to pending.
    const again = await api(`/api/cases/${loanCase.id}/requirements`, { token: owner.token });
    const same = again.body.requirements.find((r: any) => r.id === requirement.id);
    expect(same.status).toBe("waived");
  });
});
