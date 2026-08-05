import { describe, expect, it } from "vitest";

import { financialYearOf, recentFinancialYears } from "@domain/requirements/financial-year.js";

import { applyExistingDocuments, regenerateRequirements } from "./requirements.js";
import type { Database, DocumentType, LoanProduct } from "./types.js";

let counter = 0;
const nextId = (): string => `test_${++counter}`;

const DOCUMENT_TYPES: DocumentType[] = [
  { id: "dty_pan", code: "pan_card", name: "PAN Card", ownerKind: "person", requiresPeriod: false },
  { id: "dty_aadhaar", code: "aadhaar_card", name: "Aadhaar Card", ownerKind: "person", requiresPeriod: false },
  { id: "dty_address", code: "address_proof", name: "Address Proof", ownerKind: "person", requiresPeriod: false },
  { id: "dty_photo", code: "photograph", name: "Photograph", ownerKind: "person", requiresPeriod: false },
  { id: "dty_itr", code: "itr", name: "Income Tax Return", ownerKind: "person", requiresPeriod: true },
  { id: "dty_bank_stmt", code: "bank_statement", name: "Bank Statement", ownerKind: "person", requiresPeriod: true },
  { id: "dty_gst_cert", code: "gst_certificate", name: "GST Certificate", ownerKind: "organisation", requiresPeriod: false },
  { id: "dty_gst_returns", code: "gst_returns", name: "GST Returns", ownerKind: "organisation", requiresPeriod: true },
  { id: "dty_balance_sheet", code: "balance_sheet", name: "Balance Sheet", ownerKind: "organisation", requiresPeriod: true },
  { id: "dty_pl", code: "profit_and_loss", name: "Profit and Loss Statement", ownerKind: "organisation", requiresPeriod: true },
  { id: "dty_login_form", code: "login_form", name: "Login Form", ownerKind: "case", requiresPeriod: false },
];

const LOAN_PRODUCTS: LoanProduct[] = [
  { id: "lpr_pl", code: "pl", category: "Personal", variant: "Personal Loan" },
  { id: "lpr_bl", code: "bl_working_capital", category: "Business Loan", variant: "Working Capital" },
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
    cases: [],
    caseParties: [],
    caseProperties: [],
    documents: [],
    requirements: [],
    submissions: [],
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

    const generated = regenerateRequirements(db, "cas_1", nextId);
    const itrRows = generated.filter((r) => r.documentTypeId === "dty_itr");

    // itr is configured for 2 trailing years (src/domain/requirements/financial-year.ts).
    expect(itrRows).toHaveLength(2);
    const periods = itrRows.map((r) => r.periodStart).sort();
    const expected = recentFinancialYears(2).map((fy) => fy.startDate).sort();
    expect(periods).toEqual(expected);
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
        ownerUserId: "usr_1", isOnHold: false, isInvoiceRaised: false, tags: [], createdAt: new Date().toISOString(),
      },
    ];
    db.caseParties = [
      { id: "cpt_1", caseId: "cas_1", organisationId: "org_1", role: "borrower_firm", isPrimary: false },
    ];

    const generated = regenerateRequirements(db, "cas_1", nextId);

    const byType = (code: string): number =>
      generated.filter((r) => r.documentTypeId === DOCUMENT_TYPES.find((t) => t.code === code)?.id).length;

    expect(byType("gst_certificate")).toBe(1); // not financial-year-scoped — one row, unchanged
    expect(byType("gst_returns")).toBe(1); // 1 trailing year
    expect(byType("balance_sheet")).toBe(2); // 2 trailing years
    expect(byType("profit_and_loss")).toBe(2); // 2 trailing years

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
