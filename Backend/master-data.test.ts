/**
 * Master data administration — Stage 4 Item 4 acceptance tests, against real
 * Postgres and real HTTP, mirroring `Backend/documents.test.ts`'s shape.
 *
 * WHAT THIS PROVES THAT WAS NOT TRUE BEFORE THIS STAGE: document types,
 * rejection reasons, document requirement rules and thresholds had no write
 * path at all — only `Frontend/src/fake/store.ts`'s localStorage copy could
 * be edited, and it was invisible to the server, to every other employee, and
 * to the real requirement engine (`Backend/requirements.ts`). Every test here
 * exercises the real API against the real database those tables live in.
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

async function login(username: string): Promise<Session> {
  const { status, body } = await api("/api/auth/login", {
    method: "POST",
    body: { username, password: PASSWORD },
  });
  expect(status, JSON.stringify(body)).toBe(200);
  return { token: body.token, userId: body.user.id };
}

async function signInAs(role: Role): Promise<Session> {
  return await login(await createEmployee(role));
}

async function anyLoanProductId(): Promise<string> {
  const { rows } = await pool.query(`select id from loan_product limit 1`);
  return rows[0]!.id;
}

async function aCase(session: Session) {
  const customer = await api("/api/customers", {
    method: "POST",
    token: session.token,
    body: {
      fullName: `Applicant ${randomUUID().slice(0, 8)}`,
      phone: "9843012345",
      city: "Coimbatore",
    },
  });
  const created = await api("/api/cases", {
    method: "POST",
    token: session.token,
    body: { applicantId: customer.body.id, loanProductId: await anyLoanProductId() },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body as { id: string; stage: string };
}

async function toDocumentsPending(session: Session, caseId: string) {
  await api(`/api/cases/${caseId}/stage`, { method: "PUT", token: session.token, body: { stage: "contacted" } });
  const result = await api(`/api/cases/${caseId}/stage`, {
    method: "PUT",
    token: session.token,
    body: { stage: "documents_pending" },
  });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
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

describe("reading master data", () => {
  it("every role can read all four categories", async () => {
    const telecaller = await signInAs("telecaller");

    for (const path of [
      "/api/master-data/document-types",
      "/api/master-data/rejection-reasons",
      "/api/master-data/document-rules",
      "/api/master-data/thresholds",
    ]) {
      const result = await api(path, { token: telecaller.token });
      expect(result.status, `${path}: ${JSON.stringify(result.body)}`).toBe(200);
      expect(Array.isArray(result.body)).toBe(true);
      expect(result.body.length).toBeGreaterThan(0);
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const result = await api("/api/master-data/document-types");
    expect(result.status).toBe(401);
  });
});

describe("mutating master data requires master_data.manage — a telecaller is refused", () => {
  it("document types: 403 for an ordinary employee, 200 for a manager", async () => {
    const telecaller = await signInAs("telecaller");
    const manager = await signInAs("manager");

    const listing = await api("/api/master-data/document-types", { token: manager.token });
    const target = listing.body[0];

    const refused = await api(`/api/master-data/document-types/${target.id}`, {
      method: "PUT",
      token: telecaller.token,
      body: { name: target.name },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain("master_data.manage");

    const allowed = await api(`/api/master-data/document-types/${target.id}`, {
      method: "PUT",
      token: manager.token,
      body: { name: target.name, description: "Updated by an integration test." },
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.description).toBe("Updated by an integration test.");
  });

  it("rejection reasons: 403 for an ordinary employee, 200 for a manager", async () => {
    const telecaller = await signInAs("telecaller");
    const manager = await signInAs("manager");

    const listing = await api("/api/master-data/rejection-reasons", { token: manager.token });
    const target = listing.body[0];

    const refused = await api(`/api/master-data/rejection-reasons/${target.id}/active`, {
      method: "PUT",
      token: telecaller.token,
      body: { isActive: false },
    });
    expect(refused.status).toBe(403);

    const deactivated = await api(`/api/master-data/rejection-reasons/${target.id}/active`, {
      method: "PUT",
      token: manager.token,
      body: { isActive: false },
    });
    expect(deactivated.status, JSON.stringify(deactivated.body)).toBe(200);
    expect(deactivated.body.isActive).toBe(false);

    // Restore — this suite must not leave production reference data disabled.
    const restored = await api(`/api/master-data/rejection-reasons/${target.id}/active`, {
      method: "PUT",
      token: manager.token,
      body: { isActive: true },
    });
    expect(restored.status).toBe(200);
  });

  it("thresholds: 403 for an ordinary employee, 200 for a manager, rejects a bad value", async () => {
    const telecaller = await signInAs("telecaller");
    const manager = await signInAs("manager");

    const listing = await api("/api/master-data/thresholds", { token: manager.token });
    const key: string = listing.body[0].key;
    const original: number = listing.body[0].valueDays;

    const refused = await api(`/api/master-data/thresholds/${encodeURIComponent(key)}`, {
      method: "PUT",
      token: telecaller.token,
      body: { valueDays: original + 1 },
    });
    expect(refused.status).toBe(403);

    const invalid = await api(`/api/master-data/thresholds/${encodeURIComponent(key)}`, {
      method: "PUT",
      token: manager.token,
      body: { valueDays: -3 },
    });
    expect(invalid.status).toBe(400);

    const updated = await api(`/api/master-data/thresholds/${encodeURIComponent(key)}`, {
      method: "PUT",
      token: manager.token,
      body: { valueDays: original + 1 },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.valueDays).toBe(original + 1);

    // Restore.
    const restored = await api(`/api/master-data/thresholds/${encodeURIComponent(key)}`, {
      method: "PUT",
      token: manager.token,
      body: { valueDays: original },
    });
    expect(restored.status).toBe(200);
  });

  it("an unknown threshold key is refused, never silently created (the key set is fixed in code)", async () => {
    const manager = await signInAs("manager");
    const result = await api("/api/master-data/thresholds/not_a_real_key", {
      method: "PUT",
      token: manager.token,
      body: { valueDays: 5 },
    });
    expect(result.status).toBe(404);
  });
});

describe("what one session writes, another session sees — the write path is real, not local", () => {
  it("persists across a refetch on the same session, a second API session, and a fresh login as the same user", async () => {
    const managerUsername = await createEmployee("manager");
    const sessionA = await login(managerUsername);

    const before = await api("/api/master-data/rejection-reasons", { token: sessionA.token });
    const target = before.body[0];
    const newDescription = `Set by session A — ${randomUUID()}`;

    const write = await api(`/api/master-data/rejection-reasons/${target.id}`, {
      method: "PUT",
      token: sessionA.token,
      body: { name: target.name, description: newDescription },
    });
    expect(write.status, JSON.stringify(write.body)).toBe(200);

    // Same session, refetched — simulates a browser refresh.
    const refetched = await api("/api/master-data/rejection-reasons", { token: sessionA.token });
    expect(refetched.body.find((r: any) => r.id === target.id).description).toBe(newDescription);

    // A wholly different employee's session sees the same row.
    const otherEmployee = await signInAs("login_executive");
    const seenByOther = await api("/api/master-data/rejection-reasons", { token: otherEmployee.token });
    expect(seenByOther.body.find((r: any) => r.id === target.id).description).toBe(newDescription);

    // The SAME user, logged out and back in, still sees it — the value lives
    // in Postgres, not on the session or in the browser that made the change.
    await api("/api/auth/logout", { method: "POST", token: sessionA.token });
    const sessionB = await login(managerUsername);
    const seenAfterRelogin = await api("/api/master-data/rejection-reasons", { token: sessionB.token });
    expect(seenAfterRelogin.body.find((r: any) => r.id === target.id).description).toBe(newDescription);

    // Restore.
    await api(`/api/master-data/rejection-reasons/${target.id}`, {
      method: "PUT",
      token: sessionB.token,
      body: { name: target.name, description: target.description ?? "" },
    });
  });
});

describe("the real requirement engine consumes exactly the rules this API edits", () => {
  it("changing a rule's applicability through the API changes what a new case's checklist asks for", async () => {
    const manager = await signInAs("manager");
    const telecaller = await signInAs("telecaller");

    const rules = await api("/api/master-data/document-rules", { token: manager.token });
    // The unconditional KYC rule for aadhaar_card — present on every case
    // regardless of product or employment type (Database/migrations/0022).
    const rule = rules.body.find(
      (r: any) => r.documentTypeCode === "aadhaar_card" && r.conditions.length === 0,
    );
    expect(rule, JSON.stringify(rules.body.map((r: any) => r.documentTypeCode))).toBeDefined();
    expect(rule.applicability).toBe("mandatory");

    try {
      const changed = await api(`/api/master-data/document-rules/${rule.id}`, {
        method: "PUT",
        token: manager.token,
        body: {
          name: rule.name,
          applicability: "optional",
          applicableFromStage: rule.applicableFromStage,
          financialYears: rule.financialYears,
          notes: rule.notes,
        },
      });
      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(changed.body.applicability).toBe("optional");

      // A fresh case, generated fresh — Backend/requirements.ts reads
      // document_requirement_rule straight from Postgres on every read.
      const loanCase = await aCase(telecaller);
      await toDocumentsPending(telecaller, loanCase.id);
      const listing = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
      const requirement = listing.body.requirements.find(
        (r: any) => r.documentTypeCode === "aadhaar_card",
      );
      expect(requirement).toBeDefined();
      expect(requirement.applicability).toBe("optional");
    } finally {
      // Restore — every other integration test (Backend/documents.test.ts)
      // relies on aadhaar_card being mandatory KYC.
      await api(`/api/master-data/document-rules/${rule.id}`, {
        method: "PUT",
        token: manager.token,
        body: {
          name: rule.name,
          applicability: "mandatory",
          applicableFromStage: rule.applicableFromStage,
          financialYears: rule.financialYears,
          notes: rule.notes,
        },
      });
    }
  });

  it("deactivating a rule through the API stops a fresh case being asked for it", async () => {
    const manager = await signInAs("manager");
    const telecaller = await signInAs("telecaller");

    const rules = await api("/api/master-data/document-rules", { token: manager.token });
    const rule = rules.body.find(
      (r: any) => r.documentTypeCode === "pan_card" && r.conditions.length === 0,
    );
    expect(rule).toBeDefined();

    try {
      const deactivated = await api(`/api/master-data/document-rules/${rule.id}/active`, {
        method: "PUT",
        token: manager.token,
        body: { isActive: false },
      });
      expect(deactivated.status, JSON.stringify(deactivated.body)).toBe(200);

      const loanCase = await aCase(telecaller);
      await toDocumentsPending(telecaller, loanCase.id);
      const listing = await api(`/api/cases/${loanCase.id}/requirements`, { token: telecaller.token });
      expect(listing.body.requirements.some((r: any) => r.documentTypeCode === "pan_card")).toBe(false);
    } finally {
      await api(`/api/master-data/document-rules/${rule.id}/active`, {
        method: "PUT",
        token: manager.token,
        body: { isActive: true },
      });
    }
  });
});

describe("products and lenders remain read-only", () => {
  it("has no write route for reference (products) or lenders", async () => {
    const manager = await signInAs("manager");

    const productWrite = await api("/api/reference", { method: "POST", token: manager.token, body: {} });
    expect(productWrite.status).toBe(404);

    const lenderWrite = await api("/api/lenders", { method: "POST", token: manager.token, body: {} });
    expect(lenderWrite.status).toBe(404);
  });
});
