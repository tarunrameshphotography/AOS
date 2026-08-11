/**
 * Case intake and the requirement engine — acceptance tests.
 *
 * WHAT THESE PROVE. That the facts a telecaller records at intake reach the
 * rule engine and change the checklist, which is the defect this milestone
 * exists to fix: the rules could always tell salaried from self-employed, and
 * nothing ever told them which one the applicant was.
 *
 * Real rules, real PostgreSQL, real HTTP. Never a mocked rule array — a test
 * that asserts against a hand-built rule list proves the test's rules work.
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

/** A product by its catalogue code, so a test says "LAP" rather than picking
 * whatever row came back first. */
async function productByCode(code: string): Promise<string> {
  const { rows } = await pool.query(`select id from loan_product where code = $1`, [code]);
  expect(rows[0], `no loan_product with code ${code}`).toBeDefined();
  return rows[0]!.id;
}

async function masterDataId(table: string, code: string): Promise<string> {
  const { rows } = await pool.query(`select id from ${table} where code = $1`, [code]);
  expect(rows[0], `no ${table} with code ${code}`).toBeDefined();
  return rows[0]!.id;
}

async function aCustomer(session: Session, name = "Applicant"): Promise<string> {
  const { body } = await api("/api/customers", {
    method: "POST",
    token: session.token,
    body: { fullName: `${name} ${randomUUID().slice(0, 8)}`, phone: "9843012345", city: "Coimbatore" },
  });
  return body.id;
}

/** Open a case with intake facts, exactly as the New Case screen does. */
async function openCase(
  session: Session,
  productCode: string,
  facts: Record<string, unknown> = {},
): Promise<string> {
  const applicantId = await aCustomer(session);
  const created = await api("/api/cases", {
    method: "POST",
    token: session.token,
    body: { applicantId, loanProductId: await productByCode(productCode), ...facts },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id;
}

async function toDocumentsPending(session: Session, caseId: string): Promise<void> {
  for (const stage of ["contacted", "documents_pending"]) {
    const moved = await api(`/api/cases/${caseId}/stage`, {
      method: "PUT",
      token: session.token,
      body: { stage },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
  }
}

interface Requirement {
  id: string;
  documentTypeCode: string;
  status: string;
  isCustom: boolean;
  requiredOfCasePartyId: string | null;
  requiredOfCasePropertyId: string | null;
  subject: { kind: string; role: string | null; name: string | null };
  generatedByRuleCode: string | null;
  generatedByRuleName: string | null;
}

async function requirementsOf(session: Session, caseId: string): Promise<Requirement[]> {
  const { status, body } = await api(`/api/cases/${caseId}/requirements`, { token: session.token });
  expect(status, JSON.stringify(body)).toBe(200);
  return body.requirements;
}

const codesOf = (requirements: Requirement[]): string[] =>
  requirements.map((requirement) => requirement.documentTypeCode);

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
// A — Intake facts reach the engine
// ---------------------------------------------------------------------------

describe("intake facts drive the checklist", () => {
  it("records the facts on the case and its applicant", async () => {
    const owner = await signInAs("telecaller");
    const employmentTypeId = await masterDataId("employment_type", "business_owner");
    const constitutionId = await masterDataId("business_constitution", "proprietorship");

    const caseId = await openCase(owner, "lap", {
      employmentTypeId,
      businessConstitutionId: constitutionId,
      isGstRegistered: true,
      itrFiled: true,
      hasExistingObligations: false,
    });

    const { rows: caseRows } = await pool.query(
      `select is_gst_registered, has_existing_obligations from loan_case where id = $1`,
      [caseId],
    );
    expect(caseRows[0]).toMatchObject({
      is_gst_registered: true,
      has_existing_obligations: false,
    });

    const { rows: partyRows } = await pool.query(
      `select employment_type_id, business_constitution_id, itr_filed
         from case_party where case_id = $1 and is_primary`,
      [caseId],
    );
    expect(partyRows[0]).toMatchObject({
      employment_type_id: employmentTypeId,
      business_constitution_id: constitutionId,
      itr_filed: true,
    });
  });

  it("a salaried LAP applicant gets salary documents and no business or GST ones", async () => {
    const owner = await signInAs("telecaller");
    const caseId = await openCase(owner, "lap", {
      employmentTypeId: await masterDataId("employment_type", "salaried"),
    });
    await toDocumentsPending(owner, caseId);

    const codes = codesOf(await requirementsOf(owner, caseId));

    // Salaried income evidence, which never appeared before this milestone
    // because employment type was never recorded.
    expect(codes).toContain("salary_slip");
    expect(codes).toContain("form_16");

    // THE CENTRAL ASSERTION of Part 6's first example: choosing LAP must not
    // by itself produce business or GST asks.
    expect(codes).not.toContain("itr");
    expect(codes).not.toContain("gst_certificate");
    expect(codes).not.toContain("gst_returns");
    expect(codes).not.toContain("balance_sheet");
    expect(codes).not.toContain("business_proof");
  });

  it("a self-employed LAP applicant gets returns, accounts and GST — ICICI's published list", async () => {
    const owner = await signInAs("telecaller");
    const caseId = await openCase(owner, "lap", {
      employmentTypeId: await masterDataId("employment_type", "business_owner"),
      businessConstitutionId: await masterDataId("business_constitution", "proprietorship"),
      isGstRegistered: true,
      itrFiled: true,
    });
    await toDocumentsPending(owner, caseId);

    const codes = codesOf(await requirementsOf(owner, caseId));

    // "Last 2 years CA Certified/Audited ITR, computation of income, profit
    // and loss account statement and balance sheet" + "GST returns of the last
    // 1 year" + "last 6 months bank statements".
    expect(codes).toContain("itr");
    expect(codes).toContain("balance_sheet");
    expect(codes).toContain("profit_and_loss");
    expect(codes).toContain("bank_statement");
    expect(codes).toContain("gst_certificate");
    expect(codes).toContain("gst_returns");
    expect(codes).toContain("business_proof");

    // And none of the salaried set.
    expect(codes).not.toContain("salary_slip");
    expect(codes).not.toContain("form_16");
  });

  it("GST registered = no asks for neither the certificate nor the returns", async () => {
    const owner = await signInAs("telecaller");
    const caseId = await openCase(owner, "lap", {
      employmentTypeId: await masterDataId("employment_type", "business_owner"),
      isGstRegistered: false,
    });
    await toDocumentsPending(owner, caseId);

    const codes = codesOf(await requirementsOf(owner, caseId));
    expect(codes).not.toContain("gst_certificate");
    expect(codes).not.toContain("gst_returns");
    // The rest of the self-employed set is unaffected — not being registered
    // is not a reason to stop asking for the return.
    expect(codes).toContain("itr");
  });

  it("ITR filed = no stands the ITR requirement down; unanswered does not", async () => {
    const owner = await signInAs("telecaller");
    const employmentTypeId = await masterDataId("employment_type", "business_owner");

    const doesNotFile = await openCase(owner, "lap", { employmentTypeId, itrFiled: false });
    await toDocumentsPending(owner, doesNotFile);
    expect(codesOf(await requirementsOf(owner, doesNotFile))).not.toContain("itr");

    // The distinction that matters: nobody has been asked yet is NOT a no.
    const notAsked = await openCase(owner, "lap", { employmentTypeId });
    await toDocumentsPending(owner, notAsked);
    expect(codesOf(await requirementsOf(owner, notAsked))).toContain("itr");
  });

  it("entity type changes which constitution documents are asked for", async () => {
    const owner = await signInAs("telecaller");
    const employmentTypeId = await masterDataId("employment_type", "business_owner");

    // A proprietorship has no constituting document — the business IS the
    // person — so asking for a deed or an incorporation certificate would be
    // asking for something that does not exist.
    const proprietor = await openCase(owner, "lap", {
      employmentTypeId,
      businessConstitutionId: await masterDataId("business_constitution", "proprietorship"),
    });
    await toDocumentsPending(owner, proprietor);
    const proprietorCodes = codesOf(await requirementsOf(owner, proprietor));
    expect(proprietorCodes).not.toContain("partnership_deed");
    expect(proprietorCodes).not.toContain("certificate_of_incorporation");
    expect(proprietorCodes).not.toContain("moa_aoa");
    // It still evidences the business some other way.
    expect(proprietorCodes).toContain("business_proof");

    // A private limited company borrows by resolution, and its powers live in
    // the MOA/AOA. Those rules are constitution-conditioned, and the
    // constitution is now recorded at intake — so they can finally fire.
    const company = await openCase(owner, "lap", {
      employmentTypeId,
      businessConstitutionId: await masterDataId("business_constitution", "private_limited"),
    });
    const firm = await api(`/api/cases/${company}/parties`, {
      method: "POST",
      token: owner.token,
      body: { role: "borrower_firm", newOrganisationName: `Kovai Precision ${randomUUID().slice(0, 6)}` },
    });
    expect(firm.status, JSON.stringify(firm.body)).toBe(200);
    // The constitution is a fact about the FIRM, recorded on its case_party.
    const profiled = await api(`/api/cases/${company}/parties/${firm.body.id}`, {
      method: "PATCH",
      token: owner.token,
      body: { businessConstitutionId: await masterDataId("business_constitution", "private_limited") },
    });
    expect(profiled.status, JSON.stringify(profiled.body)).toBe(200);

    await toDocumentsPending(owner, company);
    const companyCodes = codesOf(await requirementsOf(owner, company));
    expect(companyCodes).toContain("certificate_of_incorporation");
    expect(companyCodes).toContain("moa_aoa");
    expect(companyCodes).toContain("board_resolution");
    expect(companyCodes).not.toContain("partnership_deed");
  });

  it("different loan types produce different checklists from the same applicant facts", async () => {
    const owner = await signInAs("telecaller");
    const employmentTypeId = await masterDataId("employment_type", "salaried");

    const lap = await openCase(owner, "lap", { employmentTypeId });
    await toDocumentsPending(owner, lap);
    const gold = await openCase(owner, "gl_gold", { employmentTypeId });
    await toDocumentsPending(owner, gold);

    const lapCodes = codesOf(await requirementsOf(owner, lap));
    const goldCodes = codesOf(await requirementsOf(owner, gold));

    // A gold loan is underwritten on the ornaments, not on the borrower.
    expect(goldCodes).toContain("gold_appraisal_note");
    expect(goldCodes).not.toContain("salary_slip");
    expect(lapCodes).toContain("salary_slip");
    expect(lapCodes).not.toContain("gold_appraisal_note");
  });

  it("is deterministic — the same facts produce the same set, twice", async () => {
    const owner = await signInAs("telecaller");
    const caseId = await openCase(owner, "lap", {
      employmentTypeId: await masterDataId("employment_type", "business_owner"),
      isGstRegistered: true,
    });
    await toDocumentsPending(owner, caseId);

    const first = codesOf(await requirementsOf(owner, caseId)).sort();
    const second = codesOf(await requirementsOf(owner, caseId)).sort();
    expect(second).toEqual(first);
  });

  it("carries an explanation for every generated requirement", async () => {
    const owner = await signInAs("telecaller");
    const caseId = await openCase(owner, "lap", {
      employmentTypeId: await masterDataId("employment_type", "salaried"),
    });
    await toDocumentsPending(owner, caseId);

    const requirements = await requirementsOf(owner, caseId);
    for (const requirement of requirements.filter((r) => !r.isCustom)) {
      expect(requirement.generatedByRuleCode, requirement.documentTypeCode).toBeTruthy();
      expect(requirement.generatedByRuleName, requirement.documentTypeCode).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// B — Subjects: whose document is whose
// ---------------------------------------------------------------------------

describe("requirement subjects are structural", () => {
  it("gives the applicant and the co-applicant their own distinct PAN and Aadhaar", async () => {
    const owner = await signInAs("telecaller");
    const caseId = await openCase(owner, "lap", {
      employmentTypeId: await masterDataId("employment_type", "salaried"),
    });

    const coApplicantId = await aCustomer(owner, "Co-applicant");
    const added = await api(`/api/cases/${caseId}/parties`, {
      method: "POST",
      token: owner.token,
      body: { role: "co_applicant", personId: coApplicantId },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);

    await toDocumentsPending(owner, caseId);
    const requirements = await requirementsOf(owner, caseId);

    const pans = requirements.filter((r) => r.documentTypeCode === "pan_card");
    expect(pans).toHaveLength(2);
    // Two rows, two DIFFERENT parties — not one row, and not two rows for the
    // same person.
    expect(new Set(pans.map((r) => r.requiredOfCasePartyId)).size).toBe(2);
    expect(pans.map((r) => r.subject.role).sort()).toEqual(["applicant", "co_applicant"]);
    for (const pan of pans) {
      expect(pan.subject.kind).toBe("party");
      expect(pan.subject.name).toBeTruthy();
    }

    const aadhaars = requirements.filter((r) => r.documentTypeCode === "aadhaar_card");
    expect(new Set(aadhaars.map((r) => r.requiredOfCasePartyId)).size).toBe(2);
  });

  it("retires a removed co-applicant's requirements without deleting them", async () => {
    const owner = await signInAs("telecaller");
    const caseId = await openCase(owner, "lap", {
      employmentTypeId: await masterDataId("employment_type", "salaried"),
    });

    const added = await api(`/api/cases/${caseId}/parties`, {
      method: "POST",
      token: owner.token,
      body: { role: "co_applicant", personId: await aCustomer(owner, "Co-applicant") },
    });
    const casePartyId = added.body.id;

    await toDocumentsPending(owner, caseId);
    expect((await requirementsOf(owner, caseId)).filter((r) => r.documentTypeCode === "pan_card")).toHaveLength(2);

    const removed = await api(`/api/cases/${caseId}/parties/${casePartyId}`, {
      method: "DELETE",
      token: owner.token,
    });
    expect(removed.status).toBe(200);

    // Gone from the live list…
    const after = await requirementsOf(owner, caseId);
    expect(after.filter((r) => r.documentTypeCode === "pan_card")).toHaveLength(1);
    expect(after.some((r) => r.requiredOfCasePartyId === casePartyId)).toBe(false);

    // …but kept on the case, marked not_applicable (BR-034). History of what
    // was once asked for is never destroyed.
    const { rows } = await pool.query(
      `select status from document_requirement where required_of_case_party_id = $1`,
      [casePartyId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === "not_applicable")).toBe(true);
  });

  it("attaches property requirements to the property, not to the applicant", async () => {
    const owner = await signInAs("login_executive");
    const caseId = await openCase(owner, "lap", {
      employmentTypeId: await masterDataId("employment_type", "salaried"),
    });

    const property = await api(`/api/cases/${caseId}/properties`, {
      method: "POST",
      token: owner.token,
      body: { role: "collateral", locality: "Saibaba Colony", city: "Coimbatore" },
    });
    expect(property.status, JSON.stringify(property.body)).toBe(200);

    await toDocumentsPending(owner, caseId);
    const requirements = await requirementsOf(owner, caseId);

    const saleDeed = requirements.find((r) => r.documentTypeCode === "sale_deed");
    expect(saleDeed).toBeDefined();
    expect(saleDeed!.requiredOfCasePropertyId).toBe(property.body.id);
    expect(saleDeed!.requiredOfCasePartyId).toBeNull();
    expect(saleDeed!.subject).toMatchObject({ kind: "property", role: "collateral" });
    expect(saleDeed!.subject.name).toBe("Saibaba Colony");

    // The Tamil Nadu core the generic checklists miss.
    const codes = codesOf(requirements);
    expect(codes).toContain("encumbrance_cert");
    expect(codes).toContain("patta_chitta");
    expect(codes).toContain("parent_document");
  });
});

// ---------------------------------------------------------------------------
// C — Bank and internal artifacts are not customer requirements
// ---------------------------------------------------------------------------

describe("only customer documents reach a collection list", () => {
  it("never asks a customer for the bank login form, NACH mandate or Amaze's own application form", async () => {
    const owner = await signInAs("telecaller");
    const caseId = await openCase(owner, "lap", {
      employmentTypeId: await masterDataId("employment_type", "salaried"),
    });
    await toDocumentsPending(owner, caseId);

    const codes = codesOf(await requirementsOf(owner, caseId));
    expect(codes).not.toContain("login_form");
    expect(codes).not.toContain("nach_mandate");
    expect(codes).not.toContain("application_form");
  });

  it("keeps the retired rules readable rather than deleting them", async () => {
    const { rows } = await pool.query(
      `select code, is_active, notes from document_requirement_rule
        where code in ('case_login_form', 'case_nach_mandate', 'case_application_form')`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.is_active, row.code).toBe(false);
      // The reason travels with the rule, so nobody has to read a migration to
      // find out why it is off.
      expect(row.notes, row.code).toMatch(/RETIRED/);
    }
  });

  it("classifies those three document types by who produces them", async () => {
    const { rows } = await pool.query(
      `select code, artifact_kind from document_type
        where artifact_kind <> 'customer' order by code`,
    );
    expect(rows).toEqual([
      { code: "application_form", artifact_kind: "internal" },
      { code: "login_form", artifact_kind: "bank_submission" },
      { code: "nach_mandate", artifact_kind: "bank_submission" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// D — Additional documents
// ---------------------------------------------------------------------------

describe("additional documents", () => {
  it("adds a hand-picked document against a party, audited, and survives regeneration", async () => {
    const owner = await signInAs("login_executive");
    const caseId = await openCase(owner, "lap", {
      employmentTypeId: await masterDataId("employment_type", "salaried"),
    });
    await toDocumentsPending(owner, caseId);

    const { rows: partyRows } = await pool.query(
      `select id from case_party where case_id = $1 and is_primary`,
      [caseId],
    );
    const casePartyId = partyRows[0]!.id;

    const added = await api(`/api/cases/${caseId}/requirements`, {
      method: "POST",
      token: owner.token,
      body: {
        documentTypeCode: "employment_certificate",
        casePartyId,
        note: "HDFC asked for this specifically",
      },
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.isCustom).toBe(true);
    expect(added.body.subject).toMatchObject({ kind: "party", role: "applicant" });
    // No rule produced it, so it claims no rule as its reason.
    expect(added.body.generatedByRuleCode).toBeNull();

    const { rows: events } = await pool.query(
      `select actor_kind, actor_user_id, entity_type, payload_after from event
        where case_id = $1 and event_type = 'requirement.added'`,
      [caseId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_kind: "user",
      actor_user_id: owner.userId,
      entity_type: "document_requirement",
    });
    // The free-text note stays OUT of the event payload (BR-051).
    expect(JSON.stringify(events[0]!.payload_after)).not.toContain("HDFC");

    // Regeneration passes it through untouched: no rule produced it, so no
    // rule's absence may withdraw it.
    const after = await requirementsOf(owner, caseId);
    const survivor = after.find((r) => r.id === added.body.id);
    expect(survivor).toBeDefined();
    expect(survivor!.status).toBe("pending");
  });

  it("refuses a document type that is not in the catalogue", async () => {
    const owner = await signInAs("login_executive");
    const caseId = await openCase(owner, "lap");

    const invented = await api(`/api/cases/${caseId}/requirements`, {
      method: "POST",
      token: owner.token,
      body: { documentTypeCode: "whatever-the-bank-wants" },
    });
    expect(invented.status).toBe(400);
    expect(invented.body.message).toMatch(/document type/i);
  });

  it("refuses a subject that is not on this case", async () => {
    const owner = await signInAs("login_executive");
    const caseId = await openCase(owner, "lap");
    const otherCaseId = await openCase(owner, "lap");
    const { rows } = await pool.query(
      `select id from case_party where case_id = $1 and is_primary`,
      [otherCaseId],
    );

    const wrong = await api(`/api/cases/${caseId}/requirements`, {
      method: "POST",
      token: owner.token,
      body: { documentTypeCode: "employment_certificate", casePartyId: rows[0]!.id },
    });
    expect(wrong.status).toBe(400);
  });

  it("refuses an employee who may read the case but not update it", async () => {
    const owner = await signInAs("telecaller");
    const caseId = await openCase(owner, "lap");

    const stranger = await signInAs("finance");
    const refused = await api(`/api/cases/${caseId}/requirements`, {
      method: "POST",
      token: stranger.token,
      body: { documentTypeCode: "employment_certificate" },
    });
    expect(refused.status).toBeGreaterThanOrEqual(403);
  });
});
