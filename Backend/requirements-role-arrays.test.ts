/**
 * `document_requirement_rule.party_roles` / `.property_roles` are Postgres
 * enum arrays (`case_party_role[]`, `case_property_role[]`). node-postgres
 * only auto-parses array OIDs it has a registered type parser for, and a
 * custom enum's array OID is not one of them — without an explicit cast, a
 * query returns the wire format as a literal string
 * (`"{applicant,co_applicant}"`), not a JS array.
 *
 * `Backend/master-data.ts` (Stage 4 Item 4) hit this as a hard crash —
 * `rule.partyRoles.map is not a function` — because it consumes the value
 * directly. `Backend/requirements.ts`'s `loadActiveRules` reads the same
 * columns the same way but never crashes, because `rules.ts`'s scope check
 * is `rule.partyRoles.includes(party.role)`, and `String.prototype.includes`
 * exists too — so an unparsed value degrades into a SUBSTRING check instead
 * of throwing. `"applicant"` is a substring of `"co_applicant"`, so a rule
 * scoped to `party_roles: ["co_applicant"]` alone would incorrectly also
 * match a party whose role is plain `"applicant"`.
 *
 * This test proves the fix (an explicit `::text[]` cast, mirroring
 * `Backend/master-data.ts`'s) — and, if the cast is ever removed, fails
 * loudly instead of silently misrouting a document to the wrong party.
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
  return { token: body.token };
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

describe("document_requirement_rule.party_roles round-trips as a real array, not a substring", () => {
  it("a rule scoped to party_roles=['co_applicant'] does not fire for a party whose role is 'applicant'", async () => {
    const telecaller = await signInAs("telecaller");

    // A document type no seeded rule currently asks for, so the only source
    // of a requirement for it is the rule this test inserts.
    const { rows: typeRows } = await pool.query(
      `select id from document_type where code = 'other_document'`,
    );
    const documentTypeId = typeRows[0]!.id;
    const { rows: applicabilityRows } = await pool.query(
      `select id from requirement_applicability where code = 'mandatory'`,
    );
    const applicabilityId = applicabilityRows[0]!.id;

    const ruleCode = `test_co_applicant_only_${randomUUID().slice(0, 8)}`;
    await pool.query(
      `insert into document_requirement_rule
         (code, name, document_type_id, scope, party_roles, applicability_id,
          applicable_from_stage, condition_match, is_active, display_order)
       values ($1, 'Test: co-applicant only', $2, 'party', array['co_applicant']::app.case_party_role[],
               $3, 'documents_pending', 'all', true, 9999)`,
      [ruleCode, documentTypeId, applicabilityId],
    );

    try {
      const customer = await api("/api/customers", {
        method: "POST",
        token: telecaller.token,
        body: { fullName: `Applicant ${randomUUID().slice(0, 8)}`, phone: "9843012345", city: "Coimbatore" },
      });
      const { rows: productRows } = await pool.query(`select id from loan_product limit 1`);
      const created = await api("/api/cases", {
        method: "POST",
        token: telecaller.token,
        body: { applicantId: customer.body.id, loanProductId: productRows[0]!.id },
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const caseId = created.body.id as string;

      // No co-applicant on this case — only the primary applicant party.
      await api(`/api/cases/${caseId}/stage`, { method: "PUT", token: telecaller.token, body: { stage: "contacted" } });
      await api(`/api/cases/${caseId}/stage`, {
        method: "PUT",
        token: telecaller.token,
        body: { stage: "documents_pending" },
      });

      const listing = await api(`/api/cases/${caseId}/requirements`, { token: telecaller.token });
      expect(listing.status, JSON.stringify(listing.body)).toBe(200);

      const wronglyRequired = listing.body.requirements.some(
        (r: any) => r.generatedByRuleCode === ruleCode,
      );
      expect(
        wronglyRequired,
        "a rule scoped to party_roles=['co_applicant'] must not fire for an 'applicant' party " +
          "('applicant' is a substring of 'co_applicant' — this is exactly the bug an unparsed " +
          "Postgres array literal would reintroduce)",
      ).toBe(false);
    } finally {
      await pool.query(`delete from document_requirement_rule where code = $1`, [ruleCode]);
    }
  });
});
