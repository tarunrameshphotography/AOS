/**
 * Requirement generation for the prototype — now an ADAPTER, not an engine.
 *
 * Before Milestone 9 this file held the rules themselves: a `KYC` array, a
 * `SECURED_PRODUCTS` set, an `if` per product. All of that is gone. The rules
 * live in `db.documentRequirementRules` (seeded from
 * @domain/requirements/default-rules.ts) and are evaluated by
 * @domain/requirements/rules.ts, which is the same code the server will run.
 *
 * What is left here is the three jobs a pure evaluator cannot do, because
 * each needs the database:
 *
 *   1. Build CaseFacts — resolve ids to master-data codes.
 *   2. Expand a financial-year requirement into one row per year, preserving
 *      years already on the file.
 *   3. Reconcile against what already exists, so regeneration keeps what was
 *      satisfied and marks what is no longer wanted `not_applicable` rather
 *      than deleting it (BR-034).
 *
 * The invariants are unchanged and still the reason this file gets tests:
 *
 *  - Requirements come from the case's actual composition, never a universal
 *    checklist (BR-033).
 *  - A party who does not exist generates NO ROWS (ADR-010). This now falls
 *    out of the engine rather than being enforced here.
 *  - Regeneration never resets a verified requirement.
 *
 * If this file's output is wrong the progress bar lies, so it remains the one
 * piece of fake backend worth being careful about.
 */

import {
  FINANCIAL_YEAR_DOCUMENT_TYPES,
  evaluateRules,
  financialYearOf,
  recentFinancialYears,
  type CaseFacts,
  type FinancialYear,
  type GeneratedRequirement,
  type PartyFacts,
  type PropertyFacts,
} from "@domain/requirements/index.js";

import type {
  Database,
  DocumentRequirement,
  Id,
  LoanCase,
} from "./types.js";

// ---------------------------------------------------------------------------
// Fact building — ids to codes, once, so the engine reads meaning
// ---------------------------------------------------------------------------

function codeOf(records: readonly { id: Id; code: string }[], id: Id | undefined): string | undefined {
  if (!id) return undefined;
  return records.find((record) => record.id === id)?.code;
}

/**
 * The employment type this party is underwritten on.
 *
 * The case-party override wins, then the person's current employment record.
 * Two sources, one answer, and the override exists so a case screen never has
 * to rewrite a shared person record to change one case's requirements
 * (Database/migrations/0021).
 */
function employmentCodeFor(db: Database, party: Database["caseParties"][number]): string | undefined {
  const override = codeOf(db.employmentTypes, party.employmentTypeId);
  if (override) return override;

  const employment = db.employments.find((e) => e.personId === party.personId && e.isCurrent);
  if (!employment) return undefined;

  // employmentType (the legacy enum) and employmentTypeId (master data) are
  // both kept and both populated (types.ts). The master-data id is preferred
  // where present; the enum's values are already the master-data codes.
  return codeOf(db.employmentTypes, employment.employmentTypeId) ?? employment.employmentType;
}

function constitutionCodeFor(
  db: Database,
  party: Database["caseParties"][number],
): string | undefined {
  const override = codeOf(db.businessConstitutions, party.businessConstitutionId);
  if (override) return override;

  const organisation = db.organisations.find((o) => o.id === party.organisationId);
  return codeOf(db.businessConstitutions, organisation?.businessConstitutionId);
}

/**
 * The borrower type, falling back to what the party self-evidently is: an
 * organisation borrows as a non-individual, a person as a resident
 * individual. NRI is the case that must be recorded explicitly, because
 * nothing about a person implies it.
 */
function borrowerTypeCodeFor(
  db: Database,
  party: Database["caseParties"][number],
): string | undefined {
  const override = codeOf(db.borrowerTypes, party.borrowerTypeId);
  if (override) return override;
  return party.organisationId ? "non_individual" : "resident_individual";
}

export function buildCaseFacts(db: Database, loanCase: LoanCase): CaseFacts {
  const product = db.loanProducts.find((p) => p.id === loanCase.loanProductId);
  const parties = db.caseParties.filter((p) => p.caseId === loanCase.id && !p.removedAt);
  const caseProperties = db.caseProperties.filter((p) => p.caseId === loanCase.id);

  const partyFacts: PartyFacts[] = parties.map((party) => ({
    casePartyId: party.id,
    role: party.role,
    kind: party.organisationId ? "organisation" : "person",
    isPrimary: party.isPrimary,
    ...(employmentCodeFor(db, party) ? { employmentTypeCode: employmentCodeFor(db, party) } : {}),
    ...(constitutionCodeFor(db, party)
      ? { businessConstitutionCode: constitutionCodeFor(db, party) }
      : {}),
    ...(borrowerTypeCodeFor(db, party)
      ? { borrowerTypeCode: borrowerTypeCodeFor(db, party) }
      : {}),
  }));

  const propertyFacts: PropertyFacts[] = caseProperties.map((link) => {
    const property = db.properties.find((p) => p.id === link.propertyId);
    // propertyType is legacy free text ("Apartment", "Plot"); propertyTypeId
    // is the master-data replacement. Prefer the id, fall back to the text
    // normalised the way a code would be written, so a case created before
    // the Master Data Engine still answers `property.type` correctly.
    const typeCode =
      codeOf(db.propertyTypes, property?.propertyTypeId) ??
      property?.propertyType?.toLowerCase().replace(/\s+/g, "_");

    return {
      casePropertyId: link.id,
      role: link.role,
      ...(typeCode ? { propertyTypeCode: typeCode } : {}),
      ...(codeOf(db.propertyOwnershipTypes, property?.propertyOwnershipTypeId)
        ? {
            ownershipTypeCode: codeOf(db.propertyOwnershipTypes, property?.propertyOwnershipTypeId),
          }
        : {}),
    };
  });

  return {
    productCode: product?.code ?? "",
    ...(codeOf(db.customerProducts, product?.customerProductId)
      ? { customerProductCode: codeOf(db.customerProducts, product?.customerProductId) }
      : {}),
    ...(codeOf(db.securityTypes, product?.securityTypeId)
      ? { securityTypeCode: codeOf(db.securityTypes, product?.securityTypeId) }
      : {}),
    ...(codeOf(db.requirementApplicabilities, product?.propertyRequirementId)
      ? { propertyRequirement: codeOf(db.requirementApplicabilities, product?.propertyRequirementId) }
      : {}),
    ...(codeOf(db.requirementApplicabilities, product?.gstRequirementId)
      ? { gstRequirement: codeOf(db.requirementApplicabilities, product?.gstRequirementId) }
      : {}),
    ...(loanCase.requestedAmount !== undefined
      ? { requestedAmount: loanCase.requestedAmount }
      : {}),
    ...(loanCase.isGstRegistered !== undefined
      ? { isGstRegistered: loanCase.isGstRegistered }
      : {}),
    ...(loanCase.constructionStage ? { constructionStage: loanCase.constructionStage } : {}),
    ...(loanCase.hasExistingObligations !== undefined
      ? { hasExistingObligations: loanCase.hasExistingObligations }
      : {}),
    parties: partyFacts,
    properties: propertyFacts,
  };
}

// ---------------------------------------------------------------------------
// Financial-year expansion
// ---------------------------------------------------------------------------

/**
 * Financial years to generate a row for: the window the RULE asks for, plus
 * any year that already has a live (non-`not_applicable`) row for this exact
 * document type and subject.
 *
 * That union is what stops two things from happening on every regenerate: a
 * verified three-year-old ITR silently becoming `not_applicable` just because
 * the default window rolled forward, and a year a user explicitly requested
 * beyond the default (`addFinancialYearRequirement` in fake/store.ts) being
 * discarded the next time anything else on the case triggers regeneration.
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

interface PlannedRow {
  documentTypeId: Id;
  applicableFromStage: DocumentRequirement["applicableFromStage"];
  requiredOfCasePartyId?: Id;
  requiredOfCasePropertyId?: Id;
  periodStart?: string;
  periodEnd?: string;
  generatedByRuleCode: string;
  applicability: string;
}

/**
 * Expand one generated requirement into one or more rows.
 *
 * Most document types are not financial-year-scoped and expand to exactly one
 * row. A rule that asks for two years produces two independent rows, because
 * one year's ITR must never be able to satisfy another's (Milestone 3).
 */
function expand(
  db: Database,
  loanCase: LoanCase,
  generated: GeneratedRequirement,
): PlannedRow[] {
  const documentType = db.documentTypes.find((t) => t.code === generated.documentTypeCode);
  // A rule naming a document type nobody created generates nothing. That is a
  // configuration error rather than a case fact, and the domain test
  // `never names a document type that does not exist` is what catches it
  // before anyone sees a checklist with a hole in it.
  if (!documentType) return [];

  const subject = {
    ...(generated.casePartyId ? { casePartyId: generated.casePartyId } : {}),
    ...(generated.casePropertyId ? { casePropertyId: generated.casePropertyId } : {}),
  };

  const base = {
    documentTypeId: documentType.id,
    applicableFromStage: generated.applicableFromStage,
    ...(generated.casePartyId ? { requiredOfCasePartyId: generated.casePartyId } : {}),
    ...(generated.casePropertyId ? { requiredOfCasePropertyId: generated.casePropertyId } : {}),
    generatedByRuleCode: generated.ruleCode,
    applicability: generated.applicability,
  };

  // The rule's own count is authoritative. The document type's default is the
  // fallback for a type that recurs but whose rule did not say how often —
  // better one year than a row that silently loses its period.
  const trailingYears =
    generated.financialYears ?? FINANCIAL_YEAR_DOCUMENT_TYPES[generated.documentTypeCode];
  if (trailingYears === undefined) {
    return [base];
  }

  return financialYearsFor(db, loanCase, documentType.id, subject, trailingYears).map((fy) => ({
    ...base,
    periodStart: fy.startDate,
    periodEnd: fy.endDate,
  }));
}

/** What this case genuinely requires, given what it actually contains. */
function planFor(db: Database, loanCase: LoanCase): PlannedRow[] {
  const facts = buildCaseFacts(db, loanCase);
  const generated = evaluateRules(db.documentRequirementRules, facts);
  return generated.flatMap((row) => expand(db, loanCase, row));
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

  const all = db.requirements.filter((r) => r.caseId === caseId);

  /**
   * Requirements a Login Executive added by hand are not part of the plan and
   * never were (Telecaller Workflow milestone, Part 6). No rule produced
   * them, so no rule's absence may withdraw them — they pass through
   * regeneration untouched, keeping their status, their document and their
   * place on the case. Only `removeCustomRequirement` takes one off the list,
   * and even that marks it not_applicable rather than deleting it.
   */
  const custom = all.filter((r) => r.isCustom);
  const existing = all.filter((r) => !r.isCustom);
  const byKey = new Map(existing.map((row) => [keyOf(row), row]));

  const wanted = planFor(db, loanCase);
  const wantedKeys = new Set(wanted.map(keyOf));
  const result: DocumentRequirement[] = [];

  for (const row of wanted) {
    const previous = byKey.get(keyOf(row));
    if (previous) {
      // Already satisfied requirements keep their status. A co-applicant added
      // in week three must not reset the applicant's verified KYC. The stage,
      // provenance and strength are refreshed from the rule, because those are
      // the rule's answer and not the case's history.
      result.push({
        ...previous,
        applicableFromStage: row.applicableFromStage,
        generatedByRuleCode: row.generatedByRuleCode,
        applicability: row.applicability,
      });
      continue;
    }
    result.push({
      id: nextId(),
      caseId,
      documentTypeId: row.documentTypeId,
      applicableFromStage: row.applicableFromStage,
      status: "pending",
      generatedByRuleCode: row.generatedByRuleCode,
      applicability: row.applicability,
      ...(row.requiredOfCasePartyId ? { requiredOfCasePartyId: row.requiredOfCasePartyId } : {}),
      ...(row.requiredOfCasePropertyId
        ? { requiredOfCasePropertyId: row.requiredOfCasePropertyId }
        : {}),
      ...(row.periodStart ? { periodStart: row.periodStart } : {}),
      ...(row.periodEnd ? { periodEnd: row.periodEnd } : {}),
    });
  }

  // No longer wanted: kept, marked not_applicable, excluded from progress
  // arithmetic entirely (BR-034). This is what a loan product changed
  // mid-case looks like — the old product's documents do not vanish from the
  // history, they stop counting.
  for (const row of existing) {
    if (!wantedKeys.has(keyOf(row))) {
      result.push({ ...row, status: "not_applicable" });
    }
  }

  return [...result, ...custom];
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
