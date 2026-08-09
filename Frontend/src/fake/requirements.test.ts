import { describe, expect, it } from "vitest";

import { DEFAULT_REQUIREMENT_RULES } from "@domain/requirements/default-rules.js";
import {
  financialYearOf,
  recentCompletedFinancialYears,
  recentFinancialYears,
} from "@domain/requirements/financial-year.js";

import { applyExistingDocuments, regenerateRequirements } from "./requirements.js";
import type { Database, DocumentType, LoanProduct } from "./types.js";

let counter = 0;
const nextId = (): string => `test_${++counter}`;

/**
 * The real default pack. These tests exercise the ADAPTER — fact building,
 * financial-year expansion and reconciliation — so running them against
 * invented rules would prove nothing about what the product actually does.
 */
const RULES: Database["documentRequirementRules"] = DEFAULT_REQUIREMENT_RULES.map(
  (rule, index) => ({ ...rule, id: `drr_${index}` }),
);

const DOCUMENT_TYPES: DocumentType[] = [
  { id: "dty_pan", code: "pan_card", name: "PAN Card", ownerKind: "person", requiresPeriod: false, isActive: true, displayOrder: 10 },
  { id: "dty_aadhaar", code: "aadhaar_card", name: "Aadhaar Card", ownerKind: "person", requiresPeriod: false, isActive: true, displayOrder: 20 },
  { id: "dty_address", code: "address_proof", name: "Address Proof", ownerKind: "person", requiresPeriod: false, isActive: true, displayOrder: 30 },
  { id: "dty_photo", code: "photograph", name: "Photograph", ownerKind: "person", requiresPeriod: false, isActive: true, displayOrder: 40 },
  { id: "dty_itr", code: "itr", name: "Income Tax Return", ownerKind: "person", requiresPeriod: true, isActive: true, displayOrder: 50, periodKind: "assessment_year" },
  { id: "dty_bank_stmt", code: "bank_statement", name: "Bank Statement", ownerKind: "person", requiresPeriod: true, isActive: true, displayOrder: 60 },
  { id: "dty_gst_cert", code: "gst_certificate", name: "GST Certificate", ownerKind: "organisation", requiresPeriod: false, isActive: true, displayOrder: 70 },
  { id: "dty_gst_returns", code: "gst_returns", name: "GST Returns", ownerKind: "organisation", requiresPeriod: true, isActive: true, displayOrder: 80 },
  { id: "dty_balance_sheet", code: "balance_sheet", name: "Balance Sheet", ownerKind: "organisation", requiresPeriod: true, isActive: true, displayOrder: 90 },
  { id: "dty_pl", code: "profit_and_loss", name: "Profit and Loss Statement", ownerKind: "organisation", requiresPeriod: true, isActive: true, displayOrder: 100 },
  { id: "dty_login_form", code: "login_form", name: "Login Form", ownerKind: "case", requiresPeriod: false, isActive: true, displayOrder: 110 },
];

const LOAN_PRODUCTS: LoanProduct[] = [
  { id: "lpr_pl", code: "pl", category: "Personal Loan", variant: "Personal Loan", name: "Personal Loan — Salaried", isActive: true, displayOrder: 10 },
  { id: "lpr_bl", code: "bl_working_capital", category: "Business Loan", variant: "Working Capital", name: "Working Capital Facility (Cash Credit)", isActive: true, displayOrder: 20 },
];

/** A minimal, otherwise-empty database — just enough for requirement generation. */
function baseDb(): Database {
  return {
    people: [],
    organisations: [],
    employments: [],
    properties: [],
    users: [],
    loanProducts: LOAN_PRODUCTS,
    documentTypes: DOCUMENT_TYPES,
    rejectionReasons: [],
    customerProducts: [],
    employmentTypes: [],
    businessConstitutions: [],
    propertyTypes: [],
    propertyOwnershipTypes: [],
    referralSources: [],
    districts: [],
    cities: [],
    borrowerTypes: [],
    securityTypes: [],
    requirementApplicabilities: [],
    lenderTypes: [],
    lenderRelationshipRoles: [],
    submissionModes: [],
    lenderInsightCategories: [],
    lenderProfiles: [],
    bankBranches: [],
    bankContacts: [],
    bankProducts: [],
    lenderSubmissionRules: [],
    lenderInsights: [],
    cases: [],
    caseParties: [],
    caseProperties: [],
    documents: [],
    requirements: [],
    documentRequirementRules: RULES,
    submissions: [],
    submissionRecipients: [],
    submissionPackages: [],
    submissionPackageRecipients: [],
    submissionPackageEmails: [],
    submissionPackageDocuments: [],
    offers: [],
    communications: [],
    notes: [],
    tasks: [],
    events: [],
    caseNumberSequence: {},
  };
}

describe("regenerateRequirements — financial-year scoping", () => {
  it("still generates exactly one row for a non-financial-year document type (preserves existing behaviour)", () => {
    const db = baseDb();
    db.people = [{ id: "per_1", fullName: "Arun Prasad", aliases: [], identifiers: [] }];
    db.cases = [
      {
        id: "cas_1", caseNumber: "AL-2026-00001", loanProductId: "lpr_pl", stage: "documents_pending",
        ownerUserId: "usr_1", isOnHold: false, isInvoiceRaised: false, tags: [], createdAt: new Date().toISOString(),
      },
    ];
    db.caseParties = [{ id: "cpt_1", caseId: "cas_1", personId: "per_1", role: "applicant", isPrimary: true }];

    const generated = regenerateRequirements(db, "cas_1", nextId);
    const panRows = generated.filter((r) => r.documentTypeId === "dty_pan");

    expect(panRows).toHaveLength(1);
    expect(panRows[0]?.periodStart).toBeUndefined();
  });

  it("generates one row per trailing financial year for a financial-year-scoped type", () => {
    const db = baseDb();
    db.people = [{ id: "per_1", fullName: "Deepa Krishnan", aliases: [], identifiers: [] }];
    db.cases = [
      {
        id: "cas_1", caseNumber: "AL-2026-00001", loanProductId: "lpr_bl", stage: "documents_pending",
        ownerUserId: "usr_1", isOnHold: false, isInvoiceRaised: false, tags: [], createdAt: new Date().toISOString(),
      },
    ];
    db.caseParties = [{ id: "cpt_1", caseId: "cas_1", personId: "per_1", role: "applicant", isPrimary: true }];
    // Self-employed: the fact the ITR rule turns on. A salaried applicant is
    // asked for Form 16 instead, which is the engine working, not a gap.
    db.employments = [
      { id: "emp_1", personId: "per_1", organisationId: "org_x", employmentType: "self_employed", isCurrent: true },
    ];

    const generated = regenerateRequirements(db, "cas_1", nextId);
    const itrRows = generated.filter((r) => r.documentTypeId === "dty_itr");

    // itr is configured for 2 trailing years (src/domain/requirements/financial-year.ts).
    // It is an assessment-year document, so its window is the last two
    // COMPLETED financial years — never the current, still-open one.
    expect(itrRows).toHaveLength(2);
    const periods = itrRows.map((r) => r.periodStart).sort();
    const expected = recentCompletedFinancialYears(2).map((fy) => fy.startDate).sort();
    expect(periods).toEqual(expected);
    // The current, in-progress financial year must never appear as an ITR ask.
    const currentFy = recentFinancialYears(1)[0];
    expect(periods).not.toContain(currentFy?.startDate);
    // Every row is independently pending — one year's status must not affect another's.
    expect(itrRows.every((r) => r.status === "pending")).toBe(true);
  });

  it("generates independent rows for gst_returns, balance_sheet and profit_and_loss on a borrowing firm, never overwriting one with another", () => {
    const db = baseDb();
    db.organisations = [
      { id: "org_1", canonicalName: "Sri Lakshmi Traders", roles: ["borrower"], aliases: [] },
    ];
    db.cases = [
      {
        id: "cas_1", caseNumber: "AL-2026-00001", loanProductId: "lpr_bl", stage: "documents_pending",
        ownerUserId: "usr_1", isGstRegistered: true, isOnHold: false, isInvoiceRaised: false,
        tags: [], createdAt: new Date().toISOString(),
      },
    ];
    db.caseParties = [
      { id: "cpt_1", caseId: "cas_1", organisationId: "org_1", role: "borrower_firm", isPrimary: false },
    ];

    const generated = regenerateRequirements(db, "cas_1", nextId);

    const byType = (code: string): number =>
      generated.filter((r) => r.documentTypeId === DOCUMENT_TYPES.find((t) => t.code === code)?.id).length;

    expect(byType("gst_certificate")).toBe(1); // not financial-year-scoped — one row, unchanged
    // 3 trailing years since the real-world-issues milestone: two points
    // barely show a trend in GSTR-3B turnover; three do.
    expect(byType("gst_returns")).toBe(3);
    expect(byType("balance_sheet")).toBe(2); // 2 trailing years — unchanged
    expect(byType("profit_and_loss")).toBe(2); // 2 trailing years — unchanged

    // Every generated id is unique — no year's row silently reused another's slot.
    expect(new Set(generated.map((r) => r.id)).size).toBe(generated.length);
  });

  it("regenerating twice does not duplicate rows or reset an already-verified year", () => {
    const db = baseDb();
    db.people = [{ id: "per_1", fullName: "Deepa Krishnan", aliases: [], identifiers: [] }];
    db.cases = [
      {
        id: "cas_1", caseNumber: "AL-2026-00001", loanProductId: "lpr_bl", stage: "documents_pending",
        ownerUserId: "usr_1", isOnHold: false, isInvoiceRaised: false, tags: [], createdAt: new Date().toISOString(),
      },
    ];
    db.caseParties = [{ id: "cpt_1", caseId: "cas_1", personId: "per_1", role: "applicant", isPrimary: true }];
    db.employments = [
      { id: "emp_1", personId: "per_1", organisationId: "org_x", employmentType: "self_employed", isCurrent: true },
    ];

    const first = regenerateRequirements(db, "cas_1", nextId);
    const itrRow = first.find((r) => r.documentTypeId === "dty_itr");
    expect(itrRow).toBeDefined();

    db.requirements = first.map((r) =>
      r.id === itrRow?.id ? { ...r, status: "verified" as const, satisfiedByDocumentId: "doc_1" } : r,
    );

    const second = regenerateRequirements(db, "cas_1", nextId);
    const itrRowsAfter = second.filter((r) => r.documentTypeId === "dty_itr");

    expect(itrRowsAfter).toHaveLength(2); // still exactly one row per trailing year, no duplicates
    expect(itrRowsAfter.find((r) => r.id === itrRow?.id)?.status).toBe("verified"); // preserved
  });

  it("preserves a year's row even after the default trailing window rolls forward", () => {
    // Simulates an old, already-generated FY2019-20 row (well outside today's
    // default 2-year window) that was verified in the past. Regeneration must
    // not silently flip it to not_applicable just because time passed.
    const db = baseDb();
    db.people = [{ id: "per_1", fullName: "Deepa Krishnan", aliases: [], identifiers: [] }];
    db.cases = [
      {
        id: "cas_1", caseNumber: "AL-2026-00001", loanProductId: "lpr_bl", stage: "documents_pending",
        ownerUserId: "usr_1", isOnHold: false, isInvoiceRaised: false, tags: [], createdAt: new Date().toISOString(),
      },
    ];
    db.caseParties = [{ id: "cpt_1", caseId: "cas_1", personId: "per_1", role: "applicant", isPrimary: true }];
    db.employments = [
      { id: "emp_1", personId: "per_1", organisationId: "org_x", employmentType: "self_employed", isCurrent: true },
    ];
    db.requirements = [
      {
        id: "req_old", caseId: "cas_1", documentTypeId: "dty_itr", requiredOfCasePartyId: "cpt_1",
        status: "verified", applicableFromStage: "documents_pending",
        periodStart: "2019-04-01", periodEnd: "2020-03-31", satisfiedByDocumentId: "doc_old",
      },
    ];

    const regenerated = regenerateRequirements(db, "cas_1", nextId);
    const oldRow = regenerated.find((r) => r.id === "req_old");

    expect(oldRow?.status).toBe("verified");
    expect(regenerated.filter((r) => r.documentTypeId === "dty_itr")).toHaveLength(3); // 2 default years + the preserved old one
  });
});

describe("applyExistingDocuments — financial-year matching", () => {
  it("does not let one year's verified document satisfy a different year's requirement", () => {
    const db = baseDb();
    const thisYear = financialYearOf(new Date());
    const lastYear = recentFinancialYears(2)[1];
    if (!lastYear) throw new Error("test setup: expected a previous financial year");

    db.documents = [
      {
        id: "doc_1", documentTypeId: "dty_itr", ownerKind: "person", personId: "per_1",
        filePath: "person/per_1/itr/v1-itr-old.pdf", version: 1,
        fileName: "itr-old.pdf", fileSizeBytes: 1000, uploadedAt: new Date().toISOString(),
        uploadedBy: "usr_1", verifiedAt: new Date().toISOString(), verifiedBy: "usr_1",
        periodStart: lastYear.startDate, periodEnd: lastYear.endDate,
      },
    ];

    const requirements = [
      {
        id: "req_current", caseId: "cas_1", documentTypeId: "dty_itr", requiredOfCasePartyId: "cpt_1",
        status: "pending" as const, applicableFromStage: "documents_pending" as const,
        periodStart: thisYear.startDate, periodEnd: thisYear.endDate,
      },
    ];
    db.caseParties = [{ id: "cpt_1", caseId: "cas_1", personId: "per_1", role: "applicant", isPrimary: true }];

    const result = applyExistingDocuments(db, requirements);
    expect(result[0]?.status).toBe("pending"); // wrong year — must not auto-satisfy
  });

  it("auto-satisfies when the verified document's year matches the requirement's year", () => {
    const db = baseDb();
    const thisYear = financialYearOf(new Date());

    db.documents = [
      {
        id: "doc_1", documentTypeId: "dty_itr", ownerKind: "person", personId: "per_1",
        filePath: "person/per_1/itr/v1-itr-current.pdf", version: 1,
        fileName: "itr-current.pdf", fileSizeBytes: 1000, uploadedAt: new Date().toISOString(),
        uploadedBy: "usr_1", verifiedAt: new Date().toISOString(), verifiedBy: "usr_1",
        periodStart: thisYear.startDate, periodEnd: thisYear.endDate,
      },
    ];

    const requirements = [
      {
        id: "req_current", caseId: "cas_1", documentTypeId: "dty_itr", requiredOfCasePartyId: "cpt_1",
        status: "pending" as const, applicableFromStage: "documents_pending" as const,
        periodStart: thisYear.startDate, periodEnd: thisYear.endDate,
      },
    ];
    db.caseParties = [{ id: "cpt_1", caseId: "cas_1", personId: "per_1", role: "applicant", isPrimary: true }];

    const result = applyExistingDocuments(db, requirements);
    expect(result[0]?.status).toBe("verified");
    expect(result[0]?.satisfiedByDocumentId).toBe("doc_1");
  });
});

/**
 * The adapter's own job: turning a database into CaseFacts, and turning a
 * changed fact into a changed checklist. The rules themselves are tested in
 * src/domain/requirements/default-rules.test.ts — these tests are about the
 * wiring between the two, which is where a rule engine usually goes wrong.
 */
describe("the engine reads the case's actual composition", () => {
  const PROPERTY_TYPES: DocumentType[] = [
    { id: "dty_sale_deed", code: "sale_deed", name: "Sale Deed", ownerKind: "property", requiresPeriod: false, isActive: true, displayOrder: 200 },
    { id: "dty_patta", code: "patta_chitta", name: "Patta / Chitta", ownerKind: "property", requiresPeriod: false, isActive: true, displayOrder: 210 },
  ];

  function homeLoanCase(): Database {
    const db = baseDb();
    db.documentTypes = [...DOCUMENT_TYPES, ...PROPERTY_TYPES];
    db.loanProducts = [
      ...LOAN_PRODUCTS,
      { id: "lpr_hl", code: "hl_purchase", category: "Home Loan", variant: "Purchase", name: "Home Loan — Purchase", isActive: true, displayOrder: 30 },
    ];
    db.people = [{ id: "per_1", fullName: "Ravi Kumar", aliases: [], identifiers: [] }];
    db.cases = [
      {
        id: "cas_1", caseNumber: "AL-2026-00001", loanProductId: "lpr_hl", stage: "documents_pending",
        ownerUserId: "usr_1", isOnHold: false, isInvoiceRaised: false, tags: [], createdAt: new Date().toISOString(),
      },
    ];
    db.caseParties = [{ id: "cpt_1", caseId: "cas_1", personId: "per_1", role: "applicant", isPrimary: true }];
    return db;
  }

  const codes = (db: Database): string[] =>
    db.requirements.map(
      (r) => db.documentTypes.find((t) => t.id === r.documentTypeId)?.code ?? "?",
    );

  it("asks for no property documents until a property exists, then asks immediately", () => {
    const db = homeLoanCase();
    db.requirements = regenerateRequirements(db, "cas_1", nextId);

    expect(codes(db)).not.toContain("sale_deed");
    expect(codes(db)).not.toContain("patta_chitta");

    db.properties = [{ id: "prp_1", locality: "Saibaba Colony", city: "Coimbatore", propertyType: "Independent House" }];
    db.caseProperties = [{ id: "cpr_1", caseId: "cas_1", propertyId: "prp_1", role: "purchase" }];
    db.requirements = regenerateRequirements(db, "cas_1", nextId);

    expect(codes(db)).toContain("sale_deed");
    expect(codes(db)).toContain("patta_chitta");
  });

  it("reads a legacy free-text property type, so a case predating master data still answers correctly", () => {
    // "Apartment" as free text must exclude patta exactly as the master-data
    // code `apartment` would. A fact that only works on new records is a fact
    // that silently misbehaves on the old ones.
    const db = homeLoanCase();
    db.properties = [{ id: "prp_1", locality: "RS Puram", propertyType: "Apartment" }];
    db.caseProperties = [{ id: "cpr_1", caseId: "cas_1", propertyId: "prp_1", role: "purchase" }];
    db.requirements = regenerateRequirements(db, "cas_1", nextId);

    expect(codes(db)).toContain("sale_deed");
    expect(codes(db)).not.toContain("patta_chitta");
  });

  it("prefers the case-party override to the person's employment record", () => {
    const db = homeLoanCase();
    db.employmentTypes = [
      { id: "emt_1", code: "salaried", name: "Salaried", isActive: true, displayOrder: 10 },
      { id: "emt_2", code: "self_employed", name: "Self-Employed", isActive: true, displayOrder: 20 },
    ];
    db.employments = [
      { id: "emp_1", personId: "per_1", organisationId: "org_x", employmentType: "salaried", isCurrent: true },
    ];

    db.requirements = regenerateRequirements(db, "cas_1", nextId);
    expect(codes(db)).not.toContain("itr");

    // Underwritten as self-employed on THIS case. The person's own record is
    // untouched — that is the whole reason the override exists.
    db.caseParties = db.caseParties.map((p) => ({ ...p, employmentTypeId: "emt_2" }));
    db.requirements = regenerateRequirements(db, "cas_1", nextId);

    expect(codes(db)).toContain("itr");
    expect(db.employments[0]?.employmentType).toBe("salaried");
  });

  it("marks the old product's documents not_applicable when the product changes, rather than deleting them", () => {
    const db = homeLoanCase();
    db.properties = [{ id: "prp_1", locality: "Peelamedu", propertyType: "Independent House" }];
    db.caseProperties = [{ id: "cpr_1", caseId: "cas_1", propertyId: "prp_1", role: "purchase" }];
    db.requirements = regenerateRequirements(db, "cas_1", nextId);

    const saleDeed = db.requirements.find((r) => r.documentTypeId === "dty_sale_deed");
    expect(saleDeed).toBeDefined();

    // Switched to an unsecured personal loan. The property rows do not vanish
    // — a document collected and then dropped is part of the case's history
    // (BR-034).
    db.cases = db.cases.map((c) => ({ ...c, loanProductId: "lpr_pl" }));
    db.caseProperties = [];
    db.requirements = regenerateRequirements(db, "cas_1", nextId);

    const after = db.requirements.find((r) => r.id === saleDeed?.id);
    expect(after).toBeDefined();
    expect(after?.status).toBe("not_applicable");
  });

  it("records which rule asked for each requirement", () => {
    const db = homeLoanCase();
    db.requirements = regenerateRequirements(db, "cas_1", nextId);

    const pan = db.requirements.find((r) => r.documentTypeId === "dty_pan");
    expect(pan?.generatedByRuleCode).toBe("kyc_pan");
    expect(pan?.applicability).toBe("mandatory");
  });
});
