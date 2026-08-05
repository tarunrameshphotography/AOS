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
 *
 * If this file's output is wrong the progress bar lies, so it is the one piece
 * of fake backend worth being careful about.
 */

import type { ProgressionStage } from "@domain/case/stages.js";

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

const FIRM_DOCUMENTS: Template[] = [
  { documentTypeCode: "gst_certificate", applicableFromStage: "documents_pending" },
  { documentTypeCode: "financial_statements", applicableFromStage: "documents_pending" },
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
        rows.push({ ...template, casePartyId: party.id });
      }
      continue;
    }

    for (const template of KYC) {
      rows.push({ ...template, casePartyId: party.id });
    }

    if (INCOME_ROLES.has(party.role)) {
      const employment = db.employments.find(
        (e) => e.personId === party.personId && e.isCurrent,
      );
      const income =
        employment?.employmentType === "salaried" ? SALARIED_INCOME : SELF_EMPLOYED_INCOME;
      for (const template of income) {
        rows.push({ ...template, casePartyId: party.id });
      }
    }
  }

  if (product && SECURED_PRODUCTS.has(product.code)) {
    for (const caseProperty of caseProperties) {
      for (const template of PROPERTY_DOCUMENTS) {
        rows.push({ ...template, casePropertyId: caseProperty.id });
      }
      if (product.code === "hl_self_construct") {
        for (const template of CONSTRUCTION_EXTRA) {
          rows.push({ ...template, casePropertyId: caseProperty.id });
        }
      }
    }
  }

  for (const template of CASE_DOCUMENTS) {
    rows.push({ ...template });
  }

  return rows;
}

function keyOf(row: {
  documentTypeId: Id;
  requiredOfCasePartyId?: Id | undefined;
  requiredOfCasePropertyId?: Id | undefined;
}): string {
  return [row.documentTypeId, row.requiredOfCasePartyId ?? "-", row.requiredOfCasePropertyId ?? "-"].join(
    "|",
  );
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
 * document of that type on file.
 *
 * This is the whole point of documents belonging to people rather than cases
 * (ADR-007): a repeat customer's second case opens with KYC already done, and
 * the product should show that as a win rather than leave it implicit.
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
