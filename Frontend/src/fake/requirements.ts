/**
 * Requirement generation for the prototype.
 *
 * The real engine will live in `src/domain/requirements/` and be driven by
 * templates in the database. This is a stand-in with the same *shape*, because
 * the shape is what the product experience depends on:
 *
 *  - Requirements are generated from the case's actual composition, never from a
 *    universal checklist (BR-033).
 *  - A party who does not exist generates NO ROWS — not rows marked N/A. Absence
 *    is silence (Principle #1, ADR-010).
 *  - Regeneration keeps what was already satisfied and marks what no longer
 *    applies `not_applicable` rather than deleting it (BR-034).
 *  - A financial-year-scoped document type (GST returns, ITR, balance sheet,
 *    profit and loss, bank statements) generates one row per required year,
 *    not one row that any year's document can satisfy — see
 *    src/domain/requirements/financial-year.ts.
 *
 * If this file's output is wrong the progress bar lies, so it is the one piece
 * of fake backend worth being careful about.
 */

import type { ProgressionStage } from "@domain/case/stages.js";
import {
  FINANCIAL_YEAR_DOCUMENT_TYPES,
  financialYearOf,
  recentFinancialYears,
  type FinancialYear,
} from "@domain/requirements/financial-year.js";

import type {
  CaseParty,
  CaseProperty,
  Database,
  DocumentRequirement,
  Id,
  LoanCase,
} from "./types.js";

interface Template {
  /** Document type code, resolved to an id at generation time. */
  documentTypeCode: string;
  applicableFromStage: ProgressionStage;
}

/** Everyone on the file needs these, whoever they are. */
const KYC: Template[] = [
  { documentTypeCode: "pan_card", applicableFromStage: "documents_pending" },
  { documentTypeCode: "aadhaar_card", applicableFromStage: "documents_pending" },
  { documentTypeCode: "address_proof", applicableFromStage: "documents_pending" },
  { documentTypeCode: "photograph", applicableFromStage: "documents_pending" },
];

const SALARIED_INCOME: Template[] = [
  { documentTypeCode: "salary_slip", applicableFromStage: "documents_pending" },
  { documentTypeCode: "form_16", applicableFromStage: "documents_pending" },
  { documentTypeCode: "bank_statement", applicableFromStage: "documents_pending" },
];

const SELF_EMPLOYED_INCOME: Template[] = [
  { documentTypeCode: "itr", applicableFromStage: "documents_pending" },
  { documentTypeCode: "bank_statement", applicableFromStage: "documents_pending" },
];

/** Only for a party who is actually contributing income — not a guarantor. */
const INCOME_ROLES = new Set(["applicant", "co_applicant"]);

const PROPERTY_DOCUMENTS: Template[] = [
  { documentTypeCode: "sale_deed", applicableFromStage: "documents_pending" },
  { documentTypeCode: "encumbrance_cert", applicableFromStage: "documents_pending" },
  // Not due until a bank is being approached: demanding a valuation on day two,
  // before a property is even chosen, makes the checklist wrong and the progress
  // bar useless (Requirements and Progress, Part 3).
  { documentTypeCode: "valuation_report", applicableFromStage: "ready_for_submission" },
];

const CONSTRUCTION_EXTRA: Template[] = [
  { documentTypeCode: "approved_plan", applicableFromStage: "documents_pending" },
];

/**
 * gst_returns, balance_sheet and profit_and_loss are financial-year-scoped
 * (Database/migrations/0011): gst_certificate is not — it is a one-time
 * registration document, not a periodic filing.
 */
const FIRM_DOCUMENTS: Template[] = [
  { documentTypeCode: "gst_certificate", applicableFromStage: "documents_pending" },
  { documentTypeCode: "gst_returns", applicableFromStage: "documents_pending" },
  { documentTypeCode: "balance_sheet", applicableFromStage: "documents_pending" },
  { documentTypeCode: "profit_and_loss", applicableFromStage: "documents_pending" },
];

const CASE_DOCUMENTS: Template[] = [
  { documentTypeCode: "login_form", applicableFromStage: "ready_for_submission" },
];

/** Products that put a property on the file. A personal loan does not. */
const SECURED_PRODUCTS = new Set([
  "hl_purchase",
  "hl_self_construct",
  "hl_plot_purchase",
  "hl_balance_transfer",
  "hl_top_up",
  "lap",
]);

interface GeneratedRow {
  documentTypeCode: string;
  applicableFromStage: ProgressionStage;
  casePartyId?: Id;
  casePropertyId?: Id;
  periodStart?: string;
  periodEnd?: string;
}

/**
 * Financial years to generate a row for: the default trailing window, plus
 * any year that already has a live (non-`not_applicable`) row for this exact
 * document type and subject.
 *
 * That union is what stops two things from happening on every regenerate:
 * a verified three-year-old ITR silently becoming `not_applicable` just
 * because the default window rolled forward, and a year a user explicitly
 * requested beyond the default (`addFinancialYearRequirement` in
 * fake/store.ts) being discarded the next time anything else on the case
 * triggers regeneration.
 */
function financialYearsFor(
  db: Database,
  loanCase: LoanCase,
  documentTypeId: Id,
  subject: { casePartyId?: Id; casePropertyId?: Id },
  trailingYears: number,
): FinancialYear[] {
  const byLabel = new Map<string, FinancialYear>();
  for (const fy of recentFinancialYears(trailingYears)) {
    byLabel.set(fy.label, fy);
  }

  for (const requirement of db.requirements) {
    if (
      requirement.caseId !== loanCase.id ||
      requirement.documentTypeId !== documentTypeId ||
      requirement.status === "not_applicable" ||
      requirement.requiredOfCasePartyId !== subject.casePartyId ||
      requirement.requiredOfCasePropertyId !== subject.casePropertyId ||
      !requirement.periodStart
    ) {
      continue;
    }
    const fy = financialYearOf(new Date(requirement.periodStart));
    byLabel.set(fy.label, fy);
  }

  return [...byLabel.values()].sort((a, b) => b.startDate.localeCompare(a.startDate));
}

/**
 * Expand one template into one or more generated rows. Most document types
 * are not financial-year-scoped and expand to exactly one row, unchanged
 * from before this feature existed.
 */
function expandTemplate(
  db: Database,
  loanCase: LoanCase,
  template: Template,
  subject: { casePartyId?: Id; casePropertyId?: Id },
): GeneratedRow[] {
  const trailingYears = FINANCIAL_YEAR_DOCUMENT_TYPES[template.documentTypeCode];
  if (trailingYears === undefined) {
    return [{ ...template, ...subject }];
  }

  const documentType = db.documentTypes.find((t) => t.code === template.documentTypeCode);
  if (!documentType) {
    return [{ ...template, ...subject }];
  }

  const years = financialYearsFor(db, loanCase, documentType.id, subject, trailingYears);
  return years.map((fy) => ({
    ...template,
    ...subject,
    periodStart: fy.startDate,
    periodEnd: fy.endDate,
  }));
}

/** What this case genuinely requires, given what it actually contains. */
function planFor(db: Database, loanCase: LoanCase): GeneratedRow[] {
  const product = db.loanProducts.find((p) => p.id === loanCase.loanProductId);
  const parties = db.caseParties.filter((p) => p.caseId === loanCase.id && !p.removedAt);
  const caseProperties = db.caseProperties.filter((p) => p.caseId === loanCase.id);

  const rows: GeneratedRow[] = [];

  for (const party of parties) {
    // A referrer is on the case for attribution. They are not applying for
    // anything, so they generate nothing.
    if (party.role === "referrer") {
      continue;
    }

    if (party.role === "borrower_firm") {
      for (const template of FIRM_DOCUMENTS) {
        rows.push(...expandTemplate(db, loanCase, template, { casePartyId: party.id }));
      }
      continue;
    }

    for (const template of KYC) {
      rows.push(...expandTemplate(db, loanCase, template, { casePartyId: party.id }));
    }

    if (INCOME_ROLES.has(party.role)) {
      const employment = db.employments.find(
        (e) => e.personId === party.personId && e.isCurrent,
      );
      const income =
        employment?.employmentType === "salaried" ? SALARIED_INCOME : SELF_EMPLOYED_INCOME;
      for (const template of income) {
        rows.push(...expandTemplate(db, loanCase, template, { casePartyId: party.id }));
      }
    }
  }

  if (product && SECURED_PRODUCTS.has(product.code)) {
    for (const caseProperty of caseProperties) {
      for (const template of PROPERTY_DOCUMENTS) {
        rows.push(...expandTemplate(db, loanCase, template, { casePropertyId: caseProperty.id }));
      }
      if (product.code === "hl_self_construct") {
        for (const template of CONSTRUCTION_EXTRA) {
          rows.push(...expandTemplate(db, loanCase, template, { casePropertyId: caseProperty.id }));
        }
      }
    }
  }

  for (const template of CASE_DOCUMENTS) {
    rows.push(...expandTemplate(db, loanCase, template, {}));
  }

  return rows;
}

function keyOf(row: {
  documentTypeId: Id;
  requiredOfCasePartyId?: Id | undefined;
  requiredOfCasePropertyId?: Id | undefined;
  periodStart?: string | undefined;
}): string {
  return [
    row.documentTypeId,
    row.requiredOfCasePartyId ?? "-",
    row.requiredOfCasePropertyId ?? "-",
    row.periodStart ?? "-",
  ].join("|");
}

/**
 * Regenerate a case's requirements, preserving what has already happened.
 *
 * Returns the full replacement set for this case. Rows that are still wanted keep
 * their status, satisfying document and waiver; rows that are no longer wanted
 * become `not_applicable` rather than disappearing, because a requirement that
 * was collected and then dropped is part of the case's history.
 */
export function regenerateRequirements(
  db: Database,
  caseId: Id,
  nextId: () => string,
): DocumentRequirement[] {
  const loanCase = db.cases.find((c) => c.id === caseId);
  if (!loanCase) {
    return [];
  }

  const existing = db.requirements.filter((r) => r.caseId === caseId);
  const byKey = new Map(existing.map((row) => [keyOf(row), row]));

  const wanted = planFor(db, loanCase)
    .map((row) => {
      const documentType = db.documentTypes.find((t) => t.code === row.documentTypeCode);
      if (!documentType) {
        return null;
      }
      return {
        documentTypeId: documentType.id,
        applicableFromStage: row.applicableFromStage,
        requiredOfCasePartyId: row.casePartyId,
        requiredOfCasePropertyId: row.casePropertyId,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const wantedKeys = new Set(wanted.map(keyOf));
  const result: DocumentRequirement[] = [];

  for (const row of wanted) {
    const previous = byKey.get(keyOf(row));
    if (previous) {
      // Already satisfied requirements keep their status. A co-applicant added in
      // week three must not reset the applicant's verified KYC.
      result.push({ ...previous, applicableFromStage: row.applicableFromStage });
      continue;
    }
    result.push({
      id: nextId(),
      caseId,
      documentTypeId: row.documentTypeId,
      applicableFromStage: row.applicableFromStage,
      status: "pending",
      ...(row.requiredOfCasePartyId ? { requiredOfCasePartyId: row.requiredOfCasePartyId } : {}),
      ...(row.requiredOfCasePropertyId
        ? { requiredOfCasePropertyId: row.requiredOfCasePropertyId }
        : {}),
      ...(row.periodStart ? { periodStart: row.periodStart } : {}),
      ...(row.periodEnd ? { periodEnd: row.periodEnd } : {}),
    });
  }

  // No longer wanted: kept, marked not_applicable, excluded from progress
  // arithmetic entirely (BR-034).
  for (const row of existing) {
    if (!wantedKeys.has(keyOf(row))) {
      result.push({ ...row, status: "not_applicable" });
    }
  }

  return result;
}

/**
 * A requirement is auto-satisfied when the person already has a verified
 * document of that type — and, for a financial-year-scoped requirement, of
 * that same year — on file.
 *
 * This is the whole point of documents belonging to people rather than cases
 * (ADR-007): a repeat customer's second case opens with KYC already done, and
 * the product should show that as a win rather than leave it implicit. The
 * year check matters equally: a person's FY2022-23 ITR on file must not
 * silently satisfy a new case's FY2024-25 requirement.
 */
export function applyExistingDocuments(
  db: Database,
  requirements: DocumentRequirement[],
): DocumentRequirement[] {
  return requirements.map((requirement) => {
    if (requirement.status !== "pending") {
      return requirement;
    }

    const party = db.caseParties.find((p) => p.id === requirement.requiredOfCasePartyId);
    const caseProperty = db.caseProperties.find(
      (p) => p.id === requirement.requiredOfCasePropertyId,
    );

    const match = db.documents.find((document) => {
      if (document.documentTypeId !== requirement.documentTypeId || !document.verifiedAt) {
        return false;
      }
      if (requirement.periodStart && document.periodStart !== requirement.periodStart) {
        return false;
      }
      if (party?.personId) return document.personId === party.personId;
      if (party?.organisationId) return document.organisationId === party.organisationId;
      if (caseProperty) return document.propertyId === caseProperty.propertyId;
      return false;
    });

    if (!match) {
      return requirement;
    }

    return { ...requirement, status: "verified" as const, satisfiedByDocumentId: match.id };
  });
}
