/**
 * Requirements — the `document_requirement` table — server-side.
 *
 * Stage 3C. THE RULE ENGINE IS NOT REIMPLEMENTED: `evaluateRules` from
 * `@domain/requirements/rules` decides what a case needs, exactly as it does
 * for the prototype store (`Frontend/src/fake/requirements.ts`). What lives
 * here is the three jobs a pure evaluator cannot do, because each needs the
 * database — the same three the prototype adapter's header names:
 *
 *   1. Build CaseFacts from Postgres rows (ids resolved to master-data codes).
 *   2. Expand a financial-year requirement into one row per year.
 *   3. Reconcile the plan against what already exists, so regeneration keeps
 *      what was satisfied and marks what is no longer wanted `not_applicable`
 *      rather than deleting it (BR-034).
 *
 * `regenerateRequirements` is idempotent and safe to call on every read: a
 * case whose facts have not changed gets back exactly the rows it already
 * had. Called this way (rather than only at creation) because Stage 3B did
 * not migrate co-applicants, properties or employment editing — the facts a
 * real case carries today are static after creation, so there is nothing to
 * regenerate against yet. It stays a genuine reconciliation, not a
 * generate-once special case, so it keeps behaving correctly once those
 * facts become editable.
 */

import {
  DOCUMENT_CATALOGUE,
  FINANCIAL_YEAR_DOCUMENT_TYPES,
  evaluateRules,
  financialYearOf,
  recentCompletedFinancialYears,
  recentFinancialYears,
  summariseProgress,
  type CaseFacts,
  type FinancialYear,
  type GeneratedRequirement,
  type PartyFacts,
  type PropertyFacts,
  type RequirementRule,
  type RequirementStatus as ProgressRequirementStatus,
} from "@domain/requirements/index.js";
import type { ApplicabilityCode as RequirementApplicabilityCode } from "@domain/products/catalogue.js";
import { CASE_STAGE_PROGRESSION, type CaseStage, type ProgressionStage } from "@domain/case/stages.js";

/** Stages from which a requirement can be due (ADR-020) — the cases worth
 * regenerating requirements for when computing progress in bulk. */
const COLLECTING_STAGES = new Set<CaseStage>(
  CASE_STAGE_PROGRESSION.slice(CASE_STAGE_PROGRESSION.indexOf("documents_pending")),
);

import type { Queryable } from "./db.js";

// ---------------------------------------------------------------------------
// Loading rules
// ---------------------------------------------------------------------------

interface RuleRow {
  id: string;
  code: string;
  name: string;
  document_type_code: string;
  scope: "case" | "party" | "property";
  party_roles: string[] | null;
  party_kind: "person" | "organisation" | null;
  property_roles: string[] | null;
  applicability_code: RequirementApplicabilityCode;
  applicable_from_stage: ProgressionStage;
  financial_years: number | null;
  condition_match: "all" | "any";
  is_active: boolean;
  display_order: number;
}

interface ConditionRow {
  rule_id: string;
  fact: string;
  operator: RequirementRule["conditions"][number]["operator"];
  values: string[] | null;
}

/** Every active rule, evaluated exactly as `@domain/requirements/rules`
 * expects — codes rather than ids, since the engine has no database. */
async function loadActiveRules(client: Queryable): Promise<RequirementRule[]> {
  const { rows: ruleRows } = await client.query<RuleRow>(
    `select r.id, r.code, r.name, dt.code as document_type_code, r.scope,
            r.party_roles, r.party_kind, r.property_roles,
            a.code as applicability_code, r.applicable_from_stage,
            r.financial_years, r.condition_match, r.is_active, r.display_order
       from document_requirement_rule r
       join document_type dt on dt.id = r.document_type_id
       join requirement_applicability a on a.id = r.applicability_id
      where r.is_active
      order by r.display_order, r.code`,
  );

  const { rows: conditionRows } = await client.query<ConditionRow>(
    `select c.rule_id, c.fact, c.operator, c.values
       from document_requirement_rule_condition c
       join document_requirement_rule r on r.id = c.rule_id
      where r.is_active
      order by c.display_order`,
  );

  const conditionsByRule = new Map<string, ConditionRow[]>();
  for (const row of conditionRows) {
    const list = conditionsByRule.get(row.rule_id) ?? [];
    list.push(row);
    conditionsByRule.set(row.rule_id, list);
  }

  return ruleRows.map((row) => ({
    code: row.code,
    name: row.name,
    documentTypeCode: row.document_type_code,
    scope: row.scope,
    ...(row.party_roles ? { partyRoles: row.party_roles } : {}),
    ...(row.party_kind ? { partyKind: row.party_kind } : {}),
    ...(row.property_roles ? { propertyRoles: row.property_roles } : {}),
    applicability: row.applicability_code,
    applicableFromStage: row.applicable_from_stage,
    ...(row.financial_years ? { financialYears: row.financial_years } : {}),
    conditions: (conditionsByRule.get(row.id) ?? []).map((condition) => ({
      fact: condition.fact as RequirementRule["conditions"][number]["fact"],
      operator: condition.operator,
      ...(condition.values ? { values: condition.values } : {}),
    })),
    match: row.condition_match,
    isActive: row.is_active,
    displayOrder: row.display_order,
  }));
}

// ---------------------------------------------------------------------------
// Building CaseFacts from Postgres rows
// ---------------------------------------------------------------------------

interface CaseFactRow {
  product_code: string;
  customer_product_code: string | null;
  security_type_code: string | null;
  property_requirement_code: RequirementApplicabilityCode | null;
  gst_requirement_code: RequirementApplicabilityCode | null;
  requested_amount: string | null;
  is_gst_registered: boolean | null;
  construction_stage: string | null;
  has_existing_obligations: boolean | null;
}

interface PartyRow {
  case_party_id: string;
  person_id: string | null;
  organisation_id: string | null;
  role: string;
  is_primary: boolean;
  employment_type_code: string | null;
  borrower_type_code: string | null;
  business_constitution_code: string | null;
}

interface PropertyRow {
  case_property_id: string;
  role: string;
  property_type_code: string | null;
  property_ownership_type_code: string | null;
}

/** Everything the rule engine may read about a case, resolved to master-data
 * codes exactly as `Frontend/src/fake/requirements.ts`'s `buildCaseFacts`
 * does — the two must agree, or a case would need different documents
 * depending on whether the prototype or the server generated its checklist. */
export async function loadCaseFacts(client: Queryable, caseId: string): Promise<CaseFacts> {
  const { rows: caseRows } = await client.query<CaseFactRow>(
    `select lp.code as product_code,
            cp.code as customer_product_code,
            st.code as security_type_code,
            pr.code as property_requirement_code,
            gr.code as gst_requirement_code,
            lc.requested_amount, lc.is_gst_registered, lc.construction_stage,
            lc.has_existing_obligations
       from loan_case lc
       join loan_product lp on lp.id = lc.loan_product_id
       left join customer_product cp on cp.id = lp.customer_product_id
       left join security_type st on st.id = lp.security_type_id
       left join requirement_applicability pr on pr.id = lp.property_requirement_id
       left join requirement_applicability gr on gr.id = lp.gst_requirement_id
      where lc.id = $1`,
    [caseId],
  );
  const caseRow = caseRows[0];
  if (!caseRow) throw new Error(`No such case: ${caseId}`);

  const { rows: partyRows } = await client.query<PartyRow>(
    `select cpa.id as case_party_id, cpa.person_id, cpa.organisation_id, cpa.role, cpa.is_primary,
            et.code as employment_type_code, bt.code as borrower_type_code,
            bc.code as business_constitution_code
       from case_party cpa
       left join employment_type et on et.id = cpa.employment_type_id
       left join borrower_type bt on bt.id = cpa.borrower_type_id
       left join business_constitution bc on bc.id = cpa.business_constitution_id
      where cpa.case_id = $1 and cpa.removed_at is null`,
    [caseId],
  );

  const { rows: propertyRows } = await client.query<PropertyRow>(
    `select cpr.id as case_property_id, cpr.role,
            pt.code as property_type_code, pot.code as property_ownership_type_code
       from case_property cpr
       join property p on p.id = cpr.property_id
       left join property_type pt on pt.id = p.property_type_id
       left join property_ownership_type pot on pot.id = p.property_ownership_type_id
      where cpr.case_id = $1 and cpr.removed_at is null`,
    [caseId],
  );

  const parties: PartyFacts[] = partyRows.map((row) => ({
    casePartyId: row.case_party_id,
    role: row.role,
    kind: row.organisation_id ? "organisation" : "person",
    isPrimary: row.is_primary,
    // Falls back to the same default the prototype uses when no case-party
    // override and no employment/business record has been captured: an
    // organisation borrows as a non-individual, a person as a resident
    // individual. NRI status must be recorded explicitly.
    borrowerTypeCode: row.borrower_type_code ?? (row.organisation_id ? "non_individual" : "resident_individual"),
    ...(row.employment_type_code ? { employmentTypeCode: row.employment_type_code } : {}),
    ...(row.business_constitution_code
      ? { businessConstitutionCode: row.business_constitution_code }
      : {}),
  }));

  const properties: PropertyFacts[] = propertyRows.map((row) => ({
    casePropertyId: row.case_property_id,
    role: row.role,
    ...(row.property_type_code ? { propertyTypeCode: row.property_type_code } : {}),
    ...(row.property_ownership_type_code
      ? { ownershipTypeCode: row.property_ownership_type_code }
      : {}),
  }));

  return {
    productCode: caseRow.product_code,
    ...(caseRow.customer_product_code ? { customerProductCode: caseRow.customer_product_code } : {}),
    ...(caseRow.security_type_code ? { securityTypeCode: caseRow.security_type_code } : {}),
    ...(caseRow.property_requirement_code
      ? { propertyRequirement: caseRow.property_requirement_code }
      : {}),
    ...(caseRow.gst_requirement_code ? { gstRequirement: caseRow.gst_requirement_code } : {}),
    ...(caseRow.requested_amount !== null ? { requestedAmount: Number(caseRow.requested_amount) } : {}),
    ...(caseRow.is_gst_registered !== null ? { isGstRegistered: caseRow.is_gst_registered } : {}),
    ...(caseRow.construction_stage ? { constructionStage: caseRow.construction_stage as CaseFacts["constructionStage"] } : {}),
    ...(caseRow.has_existing_obligations !== null
      ? { hasExistingObligations: caseRow.has_existing_obligations }
      : {}),
    parties,
    properties,
  };
}

// ---------------------------------------------------------------------------
// Planning — expand generated requirements into rows, financial years included
// ---------------------------------------------------------------------------

interface PlannedRow {
  documentTypeCode: string;
  applicableFromStage: ProgressionStage;
  requiredOfCasePartyId?: string;
  requiredOfCasePropertyId?: string;
  periodStart?: string;
  periodEnd?: string;
  generatedByRuleCode: string;
  applicability: RequirementApplicabilityCode;
}

/** Financial years to raise a row for: the rule's own window, unioned with
 * any year that already has a live row on file — mirrors
 * `Frontend/src/fake/requirements.ts`'s `financialYearsFor` so a rolling
 * default window never silently drops a year someone already has on file. */
function financialYearsFor(
  existingPeriods: readonly string[],
  trailingYears: number,
  isAssessmentYear: boolean,
): FinancialYear[] {
  const byLabel = new Map<string, FinancialYear>();
  const window = isAssessmentYear
    ? recentCompletedFinancialYears(trailingYears)
    : recentFinancialYears(trailingYears);
  for (const fy of window) byLabel.set(fy.label, fy);
  for (const periodStart of existingPeriods) {
    const fy = financialYearOf(new Date(periodStart));
    byLabel.set(fy.label, fy);
  }
  return [...byLabel.values()].sort((a, b) => b.startDate.localeCompare(a.startDate));
}

function expand(
  generated: GeneratedRequirement,
  existingPeriodsForSubject: (documentTypeCode: string, subjectKey: string) => readonly string[],
): PlannedRow[] {
  const definition = DOCUMENT_CATALOGUE.find((type) => type.code === generated.documentTypeCode);
  if (!definition) return [];

  const base = {
    documentTypeCode: generated.documentTypeCode,
    applicableFromStage: generated.applicableFromStage,
    ...(generated.casePartyId ? { requiredOfCasePartyId: generated.casePartyId } : {}),
    ...(generated.casePropertyId ? { requiredOfCasePropertyId: generated.casePropertyId } : {}),
    generatedByRuleCode: generated.ruleCode,
    applicability: generated.applicability,
  };

  const trailingYears = generated.financialYears ?? FINANCIAL_YEAR_DOCUMENT_TYPES[generated.documentTypeCode];
  if (trailingYears === undefined) return [base];

  const subjectKey = `${generated.casePartyId ?? "-"}|${generated.casePropertyId ?? "-"}`;
  const years = financialYearsFor(
    existingPeriodsForSubject(generated.documentTypeCode, subjectKey),
    trailingYears,
    definition.periodKind === "assessment_year",
  );

  return years.map((fy) => ({ ...base, periodStart: fy.startDate, periodEnd: fy.endDate }));
}

function subjectKeyOf(row: {
  documentTypeCode?: string;
  document_type_code?: string;
  requiredOfCasePartyId?: string | null;
  required_of_case_party_id?: string | null;
  requiredOfCasePropertyId?: string | null;
  required_of_case_property_id?: string | null;
  periodStart?: string | null;
  period_start?: string | null;
}): string {
  return [
    row.documentTypeCode ?? row.document_type_code ?? "",
    row.requiredOfCasePartyId ?? row.required_of_case_party_id ?? "-",
    row.requiredOfCasePropertyId ?? row.required_of_case_property_id ?? "-",
    row.periodStart ?? row.period_start ?? "-",
  ].join("|");
}

// ---------------------------------------------------------------------------
// Reconciling against what already exists
// ---------------------------------------------------------------------------

interface ExistingRequirementRow {
  id: string;
  document_type_code: string;
  required_of_case_party_id: string | null;
  required_of_case_property_id: string | null;
  period_start: string | null;
  status: string;
  is_custom: boolean;
}

/**
 * Bring `document_requirement` in line with what the rule engine says this
 * case needs right now, and return the case's full requirement set.
 *
 * Idempotent and safe to call on every read (see the file header). Never
 * resets a requirement's status: a row the plan still wants keeps its status,
 * satisfying document and waiver untouched, and only has its stage,
 * provenance and strength refreshed. A row the plan no longer wants is kept
 * and marked `not_applicable` rather than deleted (BR-034) — mirrors
 * `Frontend/src/fake/requirements.ts`'s `regenerateRequirements` exactly.
 * Hand-added (`is_custom`) requirements pass through untouched: no rule
 * produced them, so no rule's absence may withdraw them.
 */
export async function regenerateRequirements(client: Queryable, caseId: string): Promise<void> {
  // Sequential, not Promise.all: both read from the same pooled connection,
  // and node-postgres does not support two queries in flight on one client.
  const facts = await loadCaseFacts(client, caseId);
  const rules = await loadActiveRules(client);
  const generated = evaluateRules(rules, facts);

  const { rows: existingRows } = await client.query<ExistingRequirementRow>(
    `select r.id, dt.code as document_type_code, r.required_of_case_party_id,
            r.required_of_case_property_id, r.period_start::text, r.status, r.is_custom
       from document_requirement r
       join document_type dt on dt.id = r.document_type_id
      where r.case_id = $1`,
    [caseId],
  );

  const existing = existingRows.filter((row) => !row.is_custom);
  const existingByKey = new Map(existing.map((row) => [subjectKeyOf(row), row]));

  const periodsBySubject = new Map<string, string[]>();
  for (const row of existing) {
    if (row.status === "not_applicable" || !row.period_start) continue;
    const key = `${row.document_type_code}::${row.required_of_case_party_id ?? "-"}|${row.required_of_case_property_id ?? "-"}`;
    const list = periodsBySubject.get(key) ?? [];
    list.push(row.period_start);
    periodsBySubject.set(key, list);
  }

  const wanted: PlannedRow[] = generated.flatMap((row) =>
    expand(row, (documentTypeCode, subjectKey) => periodsBySubject.get(`${documentTypeCode}::${subjectKey}`) ?? []),
  );
  const wantedKeys = new Set(wanted.map(subjectKeyOf));

  // Resolve document_type codes to ids and applicability codes to ids once,
  // rather than per row.
  const documentTypeCodes = [...new Set(wanted.map((row) => row.documentTypeCode))];
  const { rows: typeRows } = documentTypeCodes.length
    ? await client.query<{ id: string; code: string }>(
        `select id, code from document_type where code = any($1)`,
        [documentTypeCodes],
      )
    : { rows: [] };
  const typeIdByCode = new Map(typeRows.map((row) => [row.code, row.id]));

  const { rows: applicabilityRows } = await client.query<{ id: string; code: string }>(
    `select id, code from requirement_applicability`,
  );
  const applicabilityIdByCode = new Map(applicabilityRows.map((row) => [row.code, row.id]));

  for (const row of wanted) {
    const previous = existingByKey.get(subjectKeyOf(row));
    const documentTypeId = typeIdByCode.get(row.documentTypeCode);
    const applicabilityId = applicabilityIdByCode.get(row.applicability);
    // A rule naming a document type or applicability nobody created generates
    // nothing, exactly as the prototype adapter's `expand` does — a
    // configuration error, not a case fact.
    if (!documentTypeId || !applicabilityId) continue;

    if (previous) {
      await client.query(
        `update document_requirement
            set applicable_from_stage = $1, generated_by_rule_id =
                  (select id from document_requirement_rule where code = $2),
                applicability_id = $3
          where id = $4`,
        [row.applicableFromStage, row.generatedByRuleCode, applicabilityId, previous.id],
      );
      continue;
    }

    await client.query(
      `insert into document_requirement
         (case_id, document_type_id, required_of_case_party_id, required_of_case_property_id,
          applicable_from_stage, period_start, period_end, generated_by_rule_id, applicability_id)
       values ($1, $2, $3, $4, $5, $6, $7,
               (select id from document_requirement_rule where code = $8), $9)`,
      [
        caseId,
        documentTypeId,
        row.requiredOfCasePartyId ?? null,
        row.requiredOfCasePropertyId ?? null,
        row.applicableFromStage,
        row.periodStart ?? null,
        row.periodEnd ?? null,
        row.generatedByRuleCode,
        applicabilityId,
      ],
    );
  }

  // No longer wanted: kept, marked not_applicable — excluded from progress
  // arithmetic entirely (BR-034), never deleted (history of what was once
  // asked for stays on the case).
  const noLongerWanted = existing.filter(
    (row) => !wantedKeys.has(subjectKeyOf(row)) && row.status !== "not_applicable",
  );
  for (const row of noLongerWanted) {
    await client.query(`update document_requirement set status = 'not_applicable' where id = $1`, [
      row.id,
    ]);
  }
}

/** Requirements outstanding right now — pending, received or rejected, i.e.
 * everything that is not verified, waived or not_applicable. This is the
 * count `Backend/cases.ts` feeds to the stage-transition guard: it is real,
 * not a placeholder, from this milestone on. */
export async function outstandingRequirementCount(client: Queryable, caseId: string): Promise<number> {
  await regenerateRequirements(client, caseId);
  const { rows } = await client.query<{ n: string }>(
    `select count(*) as n from document_requirement
      where case_id = $1 and status in ('pending', 'received', 'rejected')`,
    [caseId],
  );
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Progress for a list of cases — All Cases, cheaply
// ---------------------------------------------------------------------------

interface ProgressCaseRow {
  case_id: string;
  status: string;
  applicable_from_stage: ProgressionStage;
  applicability: RequirementApplicabilityCode;
}

/**
 * Progress for a set of cases, for the All Cases list — restoring the
 * indicator the audit found removed, now backed by real requirement data
 * instead of the prototype's local store.
 *
 * Only cases already at `documents_pending` or beyond are worth
 * regenerating: nothing is due before then (ADR-020), so an earlier-stage
 * case correctly has zero applicable requirements without a single query.
 * At Amaze's actual case volume (ADR-024: roughly ten a month) regenerating
 * a handful of in-flight cases on every list load is cheap; this is not
 * meant to scale to a portfolio of thousands without revisiting.
 */
export async function caseListProgress(
  client: Queryable,
  cases: readonly { id: string; stage: CaseStage }[],
): Promise<Map<string, ReturnType<typeof summariseProgressFor>>> {
  // Sequential — one pooled connection, one query at a time.
  const inFlight = cases.filter((c) => COLLECTING_STAGES.has(c.stage));
  for (const c of inFlight) {
    await regenerateRequirements(client, c.id);
  }

  const caseIds = cases.map((c) => c.id);
  const { rows } = caseIds.length
    ? await client.query<ProgressCaseRow>(
        `select r.case_id, r.status, r.applicable_from_stage, a.code as applicability
           from document_requirement r
           join requirement_applicability a on a.id = r.applicability_id
          where r.case_id = any($1) and r.status <> 'not_applicable'`,
        [caseIds],
      )
    : { rows: [] };

  const byCaseId = new Map<string, ProgressCaseRow[]>();
  for (const row of rows) {
    const list = byCaseId.get(row.case_id) ?? [];
    list.push(row);
    byCaseId.set(row.case_id, list);
  }

  const result = new Map<string, ReturnType<typeof summariseProgressFor>>();
  for (const c of cases) {
    result.set(c.id, summariseProgressFor(byCaseId.get(c.id) ?? [], c.stage));
  }
  return result;
}

function summariseProgressFor(rows: readonly ProgressCaseRow[], stage: CaseStage) {
  return summariseProgress(
    rows.map((row) => ({
      id: "",
      status: row.status as ProgressRequirementStatus,
      applicableFromStage: row.applicable_from_stage,
      applicability: row.applicability,
    })),
    stage,
  );
}
