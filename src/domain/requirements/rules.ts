/**
 * The Document Requirement Engine — rule evaluation.
 *
 * Source of truth: PRD/Requirements and Progress.md, ADR-035.
 * Schema: Database/migrations/0021, 0022.
 *
 * WHAT THIS MODULE IS
 *
 * A pure evaluator. It takes (a) a set of structured rules and (b) a flat
 * description of one case, and returns the list of document requirements that
 * case genuinely has. It reads no database, knows no ids, and branches on no
 * product code of its own — every product-specific decision in AOS now lives
 * in a rule row, which is the whole point of the milestone.
 *
 * Before this existed, "a home loan for a salaried applicant needs Form 16"
 * was an `if` in the requirement generator. Every new product meant new code,
 * a deploy, and a developer. After this, it is a row a business user can edit.
 *
 * WHAT IT DELIBERATELY IS NOT
 *
 *  - Not eligibility. A rule decides what to ASK FOR, never whether a case
 *    will be approved. ADR-016's warning stands: an engine that confidently
 *    returns a wrong credit answer is worse than no engine.
 *  - Not OCR. Nothing here reads a document; it only decides that one is
 *    wanted.
 *  - Not bank submission. Rules describe Amaze's own file-completeness
 *    standard, not any particular lender's checklist.
 *
 * THE TWO INVARIANTS INHERITED FROM ADR-010 AND BR-033
 *
 *  1. Absence is silence. A party who does not exist generates NO ROWS — not
 *     rows marked N/A. That falls out of the design: rules with `scope:
 *     "party"` are evaluated once per party that actually exists, so a case
 *     with no guarantor never enters the guarantor branch at all.
 *  2. Requirements are generated from the case's actual composition, never
 *     from a universal checklist. A rule that matches nothing emits nothing.
 */

import type { ProgressionStage } from "../case/stages.js";
import type { ApplicabilityCode } from "../products/catalogue.js";

// ---------------------------------------------------------------------------
// Facts — everything a rule is allowed to ask about
// ---------------------------------------------------------------------------

/**
 * A rule condition compares a fact to a literal. Four value kinds is all the
 * vocabulary needed, and keeping it to four is what lets a rule be stored as
 * a database row and edited in a form rather than compiled.
 */
export type FactValue = string | number | boolean | undefined;

/**
 * One party on the case, resolved to master-data CODES rather than ids.
 *
 * Codes, not ids, for the same reason `@domain/products` uses them: this
 * module has no database to resolve an id against, and a code is what a rule,
 * a report or a future AI prompt would name anyway. The adapter that loads a
 * case resolves ids to codes once; everything after that reads meaning.
 */
export interface PartyFacts {
  readonly casePartyId: string;
  /** applicant | co_applicant | guarantor | referrer | borrower_firm */
  readonly role: string;
  readonly kind: "person" | "organisation";
  /** salaried | self_employed | business_owner */
  readonly employmentTypeCode?: string | undefined;
  /** proprietorship | partnership | llp | private_limited | ... */
  readonly businessConstitutionCode?: string | undefined;
  /** resident_individual | nri_individual | non_individual */
  readonly borrowerTypeCode?: string | undefined;
  /** Is this party (or its firm) registered under GST? */
  readonly isGstRegistered?: boolean | undefined;
  /** Does this party already service a loan somewhere? */
  readonly hasExistingObligations?: boolean | undefined;
  /** Is this party the primary applicant? */
  readonly isPrimary?: boolean | undefined;
}

/** One property attached to the case, likewise resolved to codes. */
export interface PropertyFacts {
  readonly casePropertyId: string;
  /** collateral | purchase | both */
  readonly role: string;
  /** apartment | independent_house | plot | commercial | ... */
  readonly propertyTypeCode?: string | undefined;
  /** freehold | leasehold | ancestral | ... */
  readonly ownershipTypeCode?: string | undefined;
}

/**
 * How far a funded construction has got. Only meaningful on the construction
 * products; undefined everywhere else, which is the honest value — a plot
 * purchase has no construction stage, and defaulting one in would make
 * "requirements that appear only when applicable" quietly untrue.
 */
export const CONSTRUCTION_STAGES = [
  "not_started",
  "foundation",
  "plinth",
  "walls",
  "roofing",
  "finishing",
  "completed",
] as const;

export type ConstructionStage = (typeof CONSTRUCTION_STAGES)[number];

/** Everything the engine is allowed to know about one case. */
export interface CaseFacts {
  /** The lending product's code — hl_purchase, bl_working_capital, ... */
  readonly productCode: string;
  /** Its commercial grouping — home_loan, business_loan, lap, ... */
  readonly customerProductCode?: string | undefined;
  /** unsecured | immovable_property | gold_pledge | ... */
  readonly securityTypeCode?: string | undefined;
  /** The product's declared property and GST applicability (ADR-032). */
  readonly propertyRequirement?: ApplicabilityCode | undefined;
  readonly gstRequirement?: ApplicabilityCode | undefined;
  readonly requestedAmount?: number | undefined;
  /** Is the borrowing business registered under GST? */
  readonly isGstRegistered?: boolean | undefined;
  readonly constructionStage?: ConstructionStage | undefined;
  /** Is anyone on this file already servicing a loan? */
  readonly hasExistingObligations?: boolean | undefined;
  readonly parties: readonly PartyFacts[];
  readonly properties: readonly PropertyFacts[];
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export const CONDITION_OPERATORS = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "is_true",
  "is_false",
  "exists",
  "absent",
  "gte",
  "lte",
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

/**
 * The facts a condition may name.
 *
 * Namespaced, and deliberately a closed list: a rule editor has to offer the
 * business user a dropdown of what can be asked, and "any string" is not a
 * dropdown. Adding a fact is a one-line change here plus one in `resolveFact`
 * — which is the point at which a developer *should* be involved, because a
 * new fact means new data to capture.
 */
export const FACT_PATHS = [
  "case.product_code",
  "case.customer_product_code",
  "case.security_type_code",
  "case.property_requirement",
  "case.gst_requirement",
  "case.requested_amount",
  "case.is_gst_registered",
  "case.construction_stage",
  "case.has_existing_obligations",
  "case.has_collateral",
  "case.has_co_applicant",
  "case.has_guarantor",
  "case.has_borrower_firm",
  "party.role",
  "party.kind",
  "party.employment_type",
  "party.business_constitution",
  "party.borrower_type",
  "party.is_gst_registered",
  "party.has_existing_obligations",
  "party.is_primary",
  "property.role",
  "property.type",
  "property.ownership_type",
] as const;

export type FactPath = (typeof FACT_PATHS)[number];

export interface RuleCondition {
  readonly fact: FactPath;
  readonly operator: ConditionOperator;
  /**
   * The literals compared against. Unused by `is_true`, `is_false`, `exists`
   * and `absent`, which ask about the fact itself rather than its value.
   */
  readonly values?: readonly (string | number)[] | undefined;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** What a rule attaches its requirement to. */
export type RuleScope = "case" | "party" | "property";

export interface RequirementRule {
  /** Stable handle: kyc_pan_individual, business_gst_returns, ... */
  readonly code: string;
  /** What a business user reads in the rule list. */
  readonly name: string;
  /** The `document_type.code` this rule asks for. */
  readonly documentTypeCode: string;
  readonly scope: RuleScope;
  /**
   * For `scope: "party"` — which roles the requirement attaches to. Empty or
   * undefined means every role EXCEPT referrer, who is on the case for
   * attribution and is applying for nothing.
   */
  readonly partyRoles?: readonly string[] | undefined;
  /** For `scope: "party"` — restrict to people or to organisations. */
  readonly partyKind?: "person" | "organisation" | undefined;
  /** For `scope: "property"` — which property roles. Undefined means all. */
  readonly propertyRoles?: readonly string[] | undefined;
  /**
   * mandatory | optional | not_applicable, from the `requirement_applicability`
   * master data (Database/migrations/0016).
   *
   * `not_applicable` is a rule that has been switched off for a reason worth
   * keeping — the row stays, readable, and emits nothing. That is different
   * from `isActive: false`, which is "this rule is not in service"; both are
   * offered because business users mean different things by them.
   */
  readonly applicability: ApplicabilityCode;
  readonly applicableFromStage: ProgressionStage;
  /**
   * Trailing financial years to ask for, for recurring document types (ITR,
   * GST returns, balance sheet, P&L, bank statements). Undefined means the
   * requirement is a single, period-less row.
   */
  readonly financialYears?: number | undefined;
  readonly conditions: readonly RuleCondition[];
  /** Whether every condition must hold, or any one of them. Default "all". */
  readonly match?: "all" | "any" | undefined;
  readonly isActive: boolean;
  readonly displayOrder: number;
  /** Why this rule exists, in the words of whoever added it. */
  readonly notes?: string | undefined;
}

/** One requirement the engine says this case has. */
export interface GeneratedRequirement {
  readonly ruleCode: string;
  readonly documentTypeCode: string;
  readonly applicability: ApplicabilityCode;
  readonly applicableFromStage: ProgressionStage;
  readonly casePartyId?: string | undefined;
  readonly casePropertyId?: string | undefined;
  readonly financialYears?: number | undefined;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface EvaluationSubject {
  readonly party?: PartyFacts | undefined;
  readonly property?: PropertyFacts | undefined;
}

/**
 * Resolve one fact path against a case and, where the scope supplies one, a
 * party or a property.
 *
 * A `party.*` fact asked outside a party scope resolves to `undefined` rather
 * than throwing. That is deliberate: a rule editor will let someone build
 * that combination, and the honest answer to "what is the employment type of
 * a case-level requirement?" is "there isn't one", which every operator below
 * already handles.
 */
export function resolveFact(
  path: FactPath,
  facts: CaseFacts,
  subject: EvaluationSubject = {},
): FactValue {
  switch (path) {
    case "case.product_code":
      return facts.productCode;
    case "case.customer_product_code":
      return facts.customerProductCode;
    case "case.security_type_code":
      return facts.securityTypeCode;
    case "case.property_requirement":
      return facts.propertyRequirement;
    case "case.gst_requirement":
      return facts.gstRequirement;
    case "case.requested_amount":
      return facts.requestedAmount;
    case "case.is_gst_registered":
      return facts.isGstRegistered;
    case "case.construction_stage":
      return facts.constructionStage;
    case "case.has_existing_obligations":
      return facts.hasExistingObligations;
    case "case.has_collateral":
      return facts.properties.length > 0;
    case "case.has_co_applicant":
      return facts.parties.some((party) => party.role === "co_applicant");
    case "case.has_guarantor":
      return facts.parties.some((party) => party.role === "guarantor");
    case "case.has_borrower_firm":
      return facts.parties.some((party) => party.role === "borrower_firm");
    case "party.role":
      return subject.party?.role;
    case "party.kind":
      return subject.party?.kind;
    case "party.employment_type":
      return subject.party?.employmentTypeCode;
    case "party.business_constitution":
      return subject.party?.businessConstitutionCode;
    case "party.borrower_type":
      return subject.party?.borrowerTypeCode;
    case "party.is_gst_registered":
      // A party's own answer, falling back to the case's. A proprietor and
      // their firm are GST-registered as one fact in practice, and asking the
      // user to say so twice is how two sources of truth begin.
      return subject.party?.isGstRegistered ?? facts.isGstRegistered;
    case "party.has_existing_obligations":
      return subject.party?.hasExistingObligations ?? facts.hasExistingObligations;
    case "party.is_primary":
      return subject.party?.isPrimary;
    case "property.role":
      return subject.property?.role;
    case "property.type":
      return subject.property?.propertyTypeCode;
    case "property.ownership_type":
      return subject.property?.ownershipTypeCode;
  }
}

function toComparable(value: FactValue): string | number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

export function evaluateCondition(
  condition: RuleCondition,
  facts: CaseFacts,
  subject: EvaluationSubject = {},
): boolean {
  const value = resolveFact(condition.fact, facts, subject);
  const values = condition.values ?? [];

  switch (condition.operator) {
    case "equals":
      return toComparable(value) === values[0];
    case "not_equals":
      return toComparable(value) !== values[0];
    case "in":
      return values.includes(toComparable(value) as string | number);
    // An UNKNOWN fact is not in the list, so `not_in` holds. That is the
    // behaviour a checklist wants: "ask for this unless the product is one of
    // these three" must still ask when the product is unrecorded.
    case "not_in":
      return !values.includes(toComparable(value) as string | number);
    case "is_true":
      return value === true;
    case "is_false":
      // Explicitly false, not merely unknown — "the business said it is not
      // GST registered" and "nobody has been asked yet" are different, and a
      // rule that conflates them fires on every half-filled case.
      return value === false;
    case "exists":
      return value !== undefined && value !== "";
    case "absent":
      return value === undefined || value === "";
    case "gte":
      return typeof value === "number" && typeof values[0] === "number" && value >= values[0];
    case "lte":
      return typeof value === "number" && typeof values[0] === "number" && value <= values[0];
  }
}

export function ruleMatches(
  rule: RequirementRule,
  facts: CaseFacts,
  subject: EvaluationSubject = {},
): boolean {
  if (rule.conditions.length === 0) return true;
  const test = (condition: RuleCondition): boolean =>
    evaluateCondition(condition, facts, subject);
  return rule.match === "any" ? rule.conditions.some(test) : rule.conditions.every(test);
}

/** A referrer is on the case for attribution. They apply for nothing. */
const NON_APPLYING_ROLES = new Set(["referrer"]);

function partiesFor(rule: RequirementRule, facts: CaseFacts): PartyFacts[] {
  return facts.parties.filter((party) => {
    if (NON_APPLYING_ROLES.has(party.role)) return false;
    if (rule.partyKind && party.kind !== rule.partyKind) return false;
    if (rule.partyRoles && rule.partyRoles.length > 0) {
      return rule.partyRoles.includes(party.role);
    }
    return true;
  });
}

function propertiesFor(rule: RequirementRule, facts: CaseFacts): PropertyFacts[] {
  return facts.properties.filter((property) => {
    if (rule.propertyRoles && rule.propertyRoles.length > 0) {
      return rule.propertyRoles.includes(property.role);
    }
    return true;
  });
}

function subjectKey(row: GeneratedRequirement): string {
  return [row.documentTypeCode, row.casePartyId ?? "-", row.casePropertyId ?? "-"].join("|");
}

const APPLICABILITY_RANK: Record<string, number> = {
  mandatory: 2,
  optional: 1,
  not_applicable: 0,
};

function rank(applicability: ApplicabilityCode): number {
  return APPLICABILITY_RANK[applicability] ?? 1;
}

/**
 * Merge two rules that landed on the same document, for the same subject.
 *
 * This happens legitimately — a bank statement is asked for by the salaried
 * income rule and again by the business-banking rule for someone who is both.
 * The merge takes the strictest reading of each field: mandatory beats
 * optional, the earlier stage wins, and the longer financial-year window
 * wins. Anything else would let adding a rule quietly weaken an existing one,
 * which is the failure mode that makes people stop trusting a rules engine.
 */
function merge(
  existing: GeneratedRequirement,
  incoming: GeneratedRequirement,
  stageOrder: (stage: ProgressionStage) => number,
): GeneratedRequirement {
  const stronger = rank(incoming.applicability) > rank(existing.applicability);
  const earlier =
    stageOrder(incoming.applicableFromStage) < stageOrder(existing.applicableFromStage);
  const years = Math.max(existing.financialYears ?? 0, incoming.financialYears ?? 0);

  return {
    ...existing,
    ...(stronger ? { applicability: incoming.applicability, ruleCode: incoming.ruleCode } : {}),
    ...(earlier ? { applicableFromStage: incoming.applicableFromStage } : {}),
    ...(years > 0 ? { financialYears: years } : {}),
  };
}

const STAGE_SEQUENCE: readonly ProgressionStage[] = [
  "new",
  "contacted",
  "appointment_fixed",
  "documents_pending",
  "ready_for_submission",
  "submitted",
  "sanctioned",
  "disbursed",
];

function stageOrder(stage: ProgressionStage): number {
  const index = STAGE_SEQUENCE.indexOf(stage);
  return index === -1 ? STAGE_SEQUENCE.length : index;
}

/**
 * The engine's one entry point: what does this case require?
 *
 * Deterministic and side-effect free. The same facts and the same rules
 * always produce the same list, in the same order — which is what makes the
 * "why is this being asked for?" question answerable, and what lets the whole
 * thing be tested without a database.
 */
export function evaluateRules(
  rules: readonly RequirementRule[],
  facts: CaseFacts,
): GeneratedRequirement[] {
  const ordered = [...rules]
    .filter((rule) => rule.isActive && rule.applicability !== "not_applicable")
    .sort((a, b) => a.displayOrder - b.displayOrder || a.code.localeCompare(b.code));

  const bySubject = new Map<string, GeneratedRequirement>();

  const emit = (row: GeneratedRequirement): void => {
    const key = subjectKey(row);
    const existing = bySubject.get(key);
    bySubject.set(key, existing ? merge(existing, row, stageOrder) : row);
  };

  for (const rule of ordered) {
    const base = {
      ruleCode: rule.code,
      documentTypeCode: rule.documentTypeCode,
      applicability: rule.applicability,
      applicableFromStage: rule.applicableFromStage,
      ...(rule.financialYears ? { financialYears: rule.financialYears } : {}),
    };

    if (rule.scope === "case") {
      if (ruleMatches(rule, facts)) emit(base);
      continue;
    }

    if (rule.scope === "party") {
      for (const party of partiesFor(rule, facts)) {
        if (ruleMatches(rule, facts, { party })) {
          emit({ ...base, casePartyId: party.casePartyId });
        }
      }
      continue;
    }

    for (const property of propertiesFor(rule, facts)) {
      if (ruleMatches(rule, facts, { property })) {
        emit({ ...base, casePropertyId: property.casePropertyId });
      }
    }
  }

  return [...bySubject.values()];
}

/**
 * Which rules produced a given requirement's document type for a given
 * subject — the "why am I being asked for this?" answer.
 *
 * Cheap to compute and worth having: a checklist nobody can interrogate is a
 * checklist people work around.
 */
export function explainRequirement(
  rules: readonly RequirementRule[],
  facts: CaseFacts,
  target: { documentTypeCode: string; casePartyId?: string; casePropertyId?: string },
): RequirementRule[] {
  return evaluateRules(rules, facts)
    .filter(
      (row) =>
        row.documentTypeCode === target.documentTypeCode &&
        row.casePartyId === target.casePartyId &&
        row.casePropertyId === target.casePropertyId,
    )
    .flatMap((row) => rules.filter((rule) => rule.code === row.ruleCode));
}
