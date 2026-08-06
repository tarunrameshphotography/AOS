/**
 * The default document-requirement rule pack.
 *
 * Source of truth: ADR-035. Schema: Database/migrations/0021, 0022.
 *
 * WHAT THIS FILE IS
 *
 * Sensible defaults, researched against how banks and NBFCs lending in Tamil
 * Nadu actually ask for paperwork — and nothing more than defaults. Every rule
 * here is seeded into `document_requirement_rule` and is editable by a
 * business user afterwards. This file is what a fresh AOS starts life
 * believing; it is not what AOS enforces forever.
 *
 * That distinction is the reason the file exists at all. The alternative —
 * shipping an empty rule table and asking someone to type ninety rules on day
 * one — produces a system nobody configures, and a document checklist that is
 * blank is worse than one that is imperfect.
 *
 * RESEARCH BASIS (summarised; see Docs/Document Requirement Engine.md)
 *
 *  - KYC is universal and near-identical across lenders: PAN, Aadhaar, address
 *    proof, photograph, signature. PAN is the one every lender treats as
 *    non-negotiable above small-ticket thresholds.
 *  - Income proof splits three ways, not two: salaried (payslips + Form 16 +
 *    salary-credit banking), self-employed professional (ITR + practice/
 *    qualification proof), self-employed business (ITR + audited financials +
 *    GST). The three-way split is why `employment_type` is master data.
 *  - Business documentation is driven far more by CONSTITUTION than by
 *    product: a partnership is asked for its deed whatever it is borrowing,
 *    a private limited for its incorporation certificate, MOA/AOA and a board
 *    resolution. That is modelled here as constitution-conditioned rules
 *    rather than product-conditioned ones.
 *  - Property documentation in Tamil Nadu has a state-specific core the
 *    generic checklists miss: Patta / Chitta (revenue ownership record),
 *    the parent document / title chain, and the Encumbrance Certificate
 *    ("villangam") from the Sub-Registrar. Layout approval is DTCP or the
 *    local body; in Chennai's area it is CMDA. Every lender's legal opinion
 *    turns on these three.
 *  - Gold loans and loans against securities are documented by the SECURITY,
 *    not the borrower: KYC plus the asset, and no income proof at all. Rules
 *    that ask a gold-loan customer for two years of ITR are the single most
 *    common way a generic checklist embarrasses a branch.
 *  - Recurring documents are asked for in FINANCIAL YEARS, and lenders ask for
 *    two years of ITR and financials, one year of GST returns, and a rolling
 *    6–12 months of banking. Those counts are the trailing-year defaults here.
 *
 * WHAT THE MILESTONE 9.1 AUDIT CHANGED, AND WHY
 *
 * Live testing found the pack asking for the wrong set on real files. Five
 * findings, all of them the same shape — a rule that waited for a fact nobody
 * had recorded, or a rule scoped to a party that was not on the file:
 *
 *  1. GST NEVER APPEARED ON A BUSINESS LOAN. Every GST rule keyed off "is GST
 *     registered", which starts undefined. But the catalogue already declares
 *     `gstRequirement: mandatory` on eight business products and Commercial
 *     LAP, and `case.gst_requirement` was a resolvable fact that no rule read.
 *     It is now read. A Business Loan asks for GST out of the box.
 *  2. A REGISTERED PROPRIETOR WAS ASKED FOR THE CERTIFICATE AND NEVER FOR THE
 *     RETURNS. The individual certificate rule had no returns counterpart.
 *  3. BUSINESS FINANCIALS ONLY EXISTED FOR A SEPARATE FIRM. Balance sheet,
 *     P&L and business banking were all scoped to `borrower_firm`, so the
 *     ordinary MSME file — a proprietor borrowing in their own name — was
 *     asked for a personal ITR and nothing else. Lenders ask a proprietor for
 *     the same two years of CA-certified accounts they ask a company for.
 *  4. FORM 26AS / AIS WAS MISSING ENTIRELY. It is read against the ITR on
 *     every self-employed file in this market; a mismatch between the two is
 *     the commonest reason a file stalls in credit.
 *  5. OVER-ASKING ON ASSET-BACKED PRODUCTS. Bureau consent, guarantor
 *     documents and existing-loan statements all fired on gold loans, which
 *     are sanctioned at the counter on the ornaments and assess no FOIR.
 *
 * Also: own contribution / margin money proof on purchase products, practice
 * proof raised to mandatory on the professional loan, and an LLP now asked
 * for the resolution authorising it to borrow.
 *
 * Every one of those is a rule row. No application code branches on any of it.
 *
 * HOW TO ADD A RULE: see Docs/Document Requirement Engine.md. Short version —
 * add a row here (or in the admin screen), name the document type, choose the
 * scope, and write the conditions. No other file changes.
 */

import type { ProgressionStage } from "../case/stages.js";
import type { ApplicabilityCode } from "../products/catalogue.js";

import type { FactPath, RequirementRule, RuleCondition, RuleScope } from "./rules.js";

// ---------------------------------------------------------------------------
// Condition helpers — the rule table below is only reviewable if a condition
// reads as a sentence.
// ---------------------------------------------------------------------------

const fact = (
  path: FactPath,
  operator: RuleCondition["operator"],
  ...values: (string | number)[]
): RuleCondition => ({ fact: path, operator, ...(values.length ? { values } : {}) });

const productIn = (...codes: string[]): RuleCondition => fact("case.product_code", "in", ...codes);
const productNotIn = (...codes: string[]): RuleCondition =>
  fact("case.product_code", "not_in", ...codes);
const customerProductIn = (...codes: string[]): RuleCondition =>
  fact("case.customer_product_code", "in", ...codes);
const customerProductNotIn = (...codes: string[]): RuleCondition =>
  fact("case.customer_product_code", "not_in", ...codes);
const employmentIn = (...codes: string[]): RuleCondition =>
  fact("party.employment_type", "in", ...codes);
const constitutionIn = (...codes: string[]): RuleCondition =>
  fact("party.business_constitution", "in", ...codes);
const isTrue = (path: FactPath): RuleCondition => fact(path, "is_true");
/**
 * The product itself says GST is non-negotiable (ADR-032). Distinct from
 * anyone having ticked "GST registered" on the case, which is a fact about
 * the borrower rather than about the product, and which nobody has answered
 * on a case created five minutes ago.
 */
const gstRequiredByProduct = (): RuleCondition =>
  fact("case.gst_requirement", "equals", "mandatory");

// ---------------------------------------------------------------------------
// Product groupings, named once. A rule that lists eleven product codes inline
// is a rule nobody will maintain.
// ---------------------------------------------------------------------------

/** Products where a property is bought from someone — an agreement exists. */
const PURCHASE_PRODUCTS = [
  "hl_purchase",
  "hl_plot_purchase",
  "hl_plot_construction",
  "hl_affordable",
  "hl_nri",
];

/** Products that fund building work, in stages, against an estimate. */
const CONSTRUCTION_PRODUCTS = [
  "hl_self_construct",
  "hl_plot_construction",
  "hl_improvement",
  "hl_extension",
];

/** Products needing a sanctioned plan from the approving authority. */
const PLAN_PRODUCTS = ["hl_self_construct", "hl_plot_construction", "hl_extension", "hl_purchase"];

/** Products that take over or top up an existing facility. */
const TAKEOVER_PRODUCTS = ["hl_balance_transfer", "hl_top_up", "lap_balance_transfer"];

/**
 * Customer products documented by the security rather than by the borrower's
 * income. A gold loan asks for KYC and the ornaments; nothing else.
 */
const ASSET_ONLY_PRODUCTS = ["gold_loan", "loan_against_securities"];

/**
 * Customer products where a self-employed borrower's business is underwritten
 * properly rather than glanced at — so CA-certified financials are asked for
 * even when no firm is a party to the case.
 *
 * A ₹5 lakh unsecured personal loan is deliberately absent: it is assessed on
 * ITR and banking, and asking its customer for an audited balance sheet is
 * the same species of over-ask as asking a gold-loan customer for Form 16.
 */
const FINANCIALS_PRODUCTS = ["business_loan", "lap", "home_loan"];

/** Where a rule sits in the checklist. Blocks of 100 leave room to insert. */
const ORDER = {
  kyc: 100,
  nri: 200,
  income: 300,
  obligations: 400,
  firm: 500,
  constitution: 600,
  business: 700,
  property: 800,
  construction: 900,
  vehicle: 1000,
  gold: 1100,
  education: 1200,
  securities: 1300,
  caseLevel: 1400,
} as const;

let sequence = 0;

interface RuleInput {
  code: string;
  name: string;
  documentTypeCode: string;
  scope: RuleScope;
  partyRoles?: readonly string[];
  partyKind?: "person" | "organisation";
  propertyRoles?: readonly string[];
  applicability?: ApplicabilityCode;
  stage?: ProgressionStage;
  financialYears?: number;
  conditions?: readonly RuleCondition[];
  match?: "all" | "any";
  order: number;
  notes?: string;
}

function rule(input: RuleInput): RequirementRule {
  sequence += 1;
  return {
    code: input.code,
    name: input.name,
    documentTypeCode: input.documentTypeCode,
    scope: input.scope,
    ...(input.partyRoles ? { partyRoles: input.partyRoles } : {}),
    ...(input.partyKind ? { partyKind: input.partyKind } : {}),
    ...(input.propertyRoles ? { propertyRoles: input.propertyRoles } : {}),
    applicability: input.applicability ?? "mandatory",
    applicableFromStage: input.stage ?? "documents_pending",
    ...(input.financialYears ? { financialYears: input.financialYears } : {}),
    conditions: input.conditions ?? [],
    ...(input.match ? { match: input.match } : {}),
    isActive: true,
    // Ties broken by declaration order, so the checklist reads in the order
    // this file is written rather than alphabetically by code.
    displayOrder: input.order + sequence,
    ...(input.notes ? { notes: input.notes } : {}),
  };
}

/** Roles that supply income and are underwritten on it. */
const INCOME_ROLES = ["applicant", "co_applicant"];
/** Everyone who signs — including the guarantor, who is KYC'd like anyone else. */
const SIGNING_ROLES = ["applicant", "co_applicant", "guarantor"];

// ---------------------------------------------------------------------------
// The pack
// ---------------------------------------------------------------------------

export const DEFAULT_REQUIREMENT_RULES: readonly RequirementRule[] = [
  // -------------------------------------------------------------------------
  // KYC — every individual who signs, whatever the product.
  // -------------------------------------------------------------------------
  rule({
    code: "kyc_pan",
    name: "PAN card — every individual signing",
    documentTypeCode: "pan_card",
    scope: "party",
    partyRoles: SIGNING_ROLES,
    partyKind: "person",
    order: ORDER.kyc,
    notes: "Universal. The one identity document no lender waives above small-ticket gold.",
  }),
  rule({
    code: "kyc_aadhaar",
    name: "Aadhaar card — every individual signing",
    documentTypeCode: "aadhaar_card",
    scope: "party",
    partyRoles: SIGNING_ROLES,
    partyKind: "person",
    order: ORDER.kyc,
    notes: "Serves as identity and address proof; used for e-KYC by most lenders.",
  }),
  rule({
    code: "kyc_address_proof",
    name: "Address proof — every individual signing",
    documentTypeCode: "address_proof",
    scope: "party",
    partyRoles: SIGNING_ROLES,
    partyKind: "person",
    order: ORDER.kyc,
  }),
  rule({
    code: "kyc_photograph",
    name: "Photograph — every individual signing",
    documentTypeCode: "photograph",
    scope: "party",
    partyRoles: SIGNING_ROLES,
    partyKind: "person",
    order: ORDER.kyc,
  }),
  rule({
    code: "kyc_signature_proof",
    name: "Signature proof",
    documentTypeCode: "signature_proof",
    scope: "party",
    partyRoles: SIGNING_ROLES,
    partyKind: "person",
    applicability: "optional",
    order: ORDER.kyc,
    notes: "Asked for by some lenders where the PAN signature is unclear.",
  }),
  rule({
    code: "kyc_credit_bureau_consent",
    name: "Credit bureau consent",
    documentTypeCode: "credit_bureau_consent",
    scope: "party",
    partyRoles: SIGNING_ROLES,
    partyKind: "person",
    conditions: [customerProductNotIn("gold_loan")],
    order: ORDER.kyc,
    notes:
      "A bureau pull without written consent is not a shortcut, it is a breach. " +
      "Excluded on gold, which is underwritten on the ornaments and is routinely " +
      "sanctioned at the counter without a bureau pull at all.",
  }),

  // -------------------------------------------------------------------------
  // NRI — same security, different paperwork.
  // -------------------------------------------------------------------------
  rule({
    code: "nri_passport",
    name: "Passport — NRI applicant",
    documentTypeCode: "passport",
    scope: "party",
    partyRoles: SIGNING_ROLES,
    partyKind: "person",
    conditions: [fact("party.borrower_type", "equals", "nri_individual")],
    order: ORDER.nri,
  }),
  rule({
    code: "nri_visa",
    name: "Visa or work permit — NRI applicant",
    documentTypeCode: "visa",
    scope: "party",
    partyRoles: SIGNING_ROLES,
    partyKind: "person",
    conditions: [fact("party.borrower_type", "equals", "nri_individual")],
    order: ORDER.nri,
  }),
  rule({
    code: "nri_overseas_income",
    name: "Overseas income proof — NRI applicant",
    documentTypeCode: "overseas_income_proof",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    conditions: [fact("party.borrower_type", "equals", "nri_individual")],
    order: ORDER.nri,
    notes: "Overseas payslips or an employment contract, usually attested.",
  }),
  rule({
    code: "nri_power_of_attorney",
    name: "Power of attorney — NRI applicant",
    documentTypeCode: "power_of_attorney",
    scope: "party",
    partyRoles: ["applicant"],
    partyKind: "person",
    conditions: [fact("party.borrower_type", "equals", "nri_individual")],
    stage: "ready_for_submission",
    order: ORDER.nri,
    notes: "A resident POA holder is how the lender gets documents executed in India.",
  }),

  // -------------------------------------------------------------------------
  // Income — salaried.
  //
  // Every income rule carries `customer_product not_in (gold, securities)`.
  // A gold loan is underwritten on the ornaments; asking its customer for
  // Form 16 is the classic generic-checklist embarrassment.
  // -------------------------------------------------------------------------
  rule({
    code: "income_salary_slip",
    name: "Salary slips — salaried",
    documentTypeCode: "salary_slip",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    conditions: [employmentIn("salaried"), customerProductNotIn(...ASSET_ONLY_PRODUCTS)],
    order: ORDER.income,
    notes: "Last three months is the market norm; six for variable-pay profiles.",
  }),
  rule({
    code: "income_form_16",
    name: "Form 16 — salaried",
    documentTypeCode: "form_16",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    financialYears: 2,
    conditions: [employmentIn("salaried"), customerProductNotIn(...ASSET_ONLY_PRODUCTS)],
    order: ORDER.income,
  }),
  rule({
    code: "income_salaried_banking",
    name: "Bank statement — salary credit account",
    documentTypeCode: "bank_statement",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    financialYears: 1,
    conditions: [employmentIn("salaried"), customerProductNotIn(...ASSET_ONLY_PRODUCTS)],
    order: ORDER.income,
    notes: "Six months of the salary-credit account.",
  }),
  rule({
    code: "income_employment_certificate",
    name: "Employment certificate",
    documentTypeCode: "employment_certificate",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    applicability: "optional",
    conditions: [employmentIn("salaried"), customerProductNotIn(...ASSET_ONLY_PRODUCTS)],
    order: ORDER.income,
  }),
  rule({
    code: "income_appointment_letter",
    name: "Appointment letter",
    documentTypeCode: "appointment_letter",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    applicability: "optional",
    conditions: [employmentIn("salaried"), customerProductNotIn(...ASSET_ONLY_PRODUCTS)],
    order: ORDER.income,
    notes: "Asked for where employment vintage is short.",
  }),

  // -------------------------------------------------------------------------
  // Income — self-employed and business owner.
  // -------------------------------------------------------------------------
  rule({
    code: "income_itr",
    name: "Income tax return — self-employed",
    documentTypeCode: "itr",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    financialYears: 2,
    conditions: [
      employmentIn("self_employed", "business_owner"),
      customerProductNotIn(...ASSET_ONLY_PRODUCTS),
    ],
    order: ORDER.income,
    notes: "Two assessment years with computation; the market standard.",
  }),
  rule({
    code: "income_self_employed_banking",
    name: "Bank statement — self-employed",
    documentTypeCode: "bank_statement",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    financialYears: 1,
    conditions: [
      employmentIn("self_employed", "business_owner"),
      customerProductNotIn(...ASSET_ONLY_PRODUCTS),
    ],
    order: ORDER.income,
    notes: "Twelve months, since there is no salary credit to read instead.",
  }),
  /**
   * Form 26AS / AIS. Added by the Milestone 9.1 audit — the first pack asked
   * for the ITR and stopped, and every lender in this market reads the two
   * together, because 26AS is the one income document the borrower cannot
   * author. Same trailing window as the ITR it is checked against.
   */
  rule({
    code: "income_form_26as",
    name: "Form 26AS / AIS — self-employed",
    documentTypeCode: "form_26as",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    financialYears: 2,
    conditions: [
      employmentIn("self_employed", "business_owner"),
      customerProductNotIn(...ASSET_ONLY_PRODUCTS),
    ],
    order: ORDER.income,
    notes: "Cross-checked against the ITR. A mismatch is the commonest reason a file stalls.",
  }),
  rule({
    code: "income_form_26as_salaried",
    name: "Form 26AS / AIS — salaried",
    documentTypeCode: "form_26as",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    applicability: "optional",
    financialYears: 1,
    conditions: [employmentIn("salaried"), customerProductNotIn(...ASSET_ONLY_PRODUCTS)],
    order: ORDER.income,
    notes: "Supporting, not primary — Form 16 already carries the employer's TDS.",
  }),

  /**
   * Business financials for a borrower with NO firm on the file.
   *
   * The audit's second finding. The balance sheet, P&L and business banking
   * rules were all scoped to `borrower_firm`, so a proprietor borrowing in
   * their own name — the ordinary shape of an MSME file in this market — was
   * asked for a personal ITR and nothing else. Lenders ask a proprietor for
   * exactly the same two years of CA-certified accounts they ask a company
   * for; the difference is whose name is on them, not whether they exist.
   */
  rule({
    code: "income_balance_sheet_individual",
    name: "Balance sheet — business borrower without a firm on the file",
    documentTypeCode: "balance_sheet",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    financialYears: 2,
    conditions: [
      employmentIn("self_employed", "business_owner"),
      fact("case.has_borrower_firm", "is_false"),
      customerProductIn(...FINANCIALS_PRODUCTS),
    ],
    order: ORDER.income,
    notes: "CA-certified, two years. Where the firm IS on the file, the firm's own rule covers this.",
  }),
  rule({
    code: "income_profit_and_loss_individual",
    name: "Profit and loss — business borrower without a firm on the file",
    documentTypeCode: "profit_and_loss",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    financialYears: 2,
    conditions: [
      employmentIn("self_employed", "business_owner"),
      fact("case.has_borrower_firm", "is_false"),
      customerProductIn(...FINANCIALS_PRODUCTS),
    ],
    order: ORDER.income,
  }),
  rule({
    code: "income_qualification_proof",
    name: "Qualification certificate — professional",
    documentTypeCode: "qualification_proof",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    conditions: [productIn("pl_professional")],
    order: ORDER.income,
    notes: "A professional loan is priced off the qualification; without it there is no product.",
  }),
  rule({
    code: "income_practice_proof",
    name: "Professional practice proof",
    documentTypeCode: "professional_practice_proof",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    applicability: "optional",
    conditions: [employmentIn("self_employed"), customerProductNotIn(...ASSET_ONLY_PRODUCTS)],
    order: ORDER.income,
    notes: "Practice vintage — registration, clinic licence, professional body membership.",
  }),
  rule({
    code: "income_practice_proof_professional",
    name: "Professional practice proof — professional loan",
    documentTypeCode: "professional_practice_proof",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    conditions: [productIn("pl_professional")],
    order: ORDER.income,
    notes:
      "Mandatory here, unlike the general optional rule above: a professional loan " +
      "is priced off qualification AND vintage, so practice proof is the product, " +
      "not a supporting document. The engine merges the two to the stricter reading.",
  }),
  rule({
    code: "income_business_proof_individual",
    name: "Business proof — business owner without a firm on the file",
    documentTypeCode: "business_proof",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    conditions: [
      employmentIn("business_owner"),
      fact("case.has_borrower_firm", "is_false"),
      customerProductNotIn(...ASSET_ONLY_PRODUCTS),
    ],
    order: ORDER.income,
    notes:
      "A proprietor borrowing in their own name still has to evidence the business. " +
      "Where the firm IS on the file, the firm's own rules cover this instead.",
  }),

  // -------------------------------------------------------------------------
  // Guarantor — KYC'd like anyone else, underwritten more lightly.
  // -------------------------------------------------------------------------
  rule({
    code: "guarantor_itr",
    name: "Income tax return — guarantor",
    documentTypeCode: "itr",
    scope: "party",
    partyRoles: ["guarantor"],
    partyKind: "person",
    applicability: "optional",
    financialYears: 1,
    conditions: [customerProductNotIn(...ASSET_ONLY_PRODUCTS)],
    order: ORDER.income,
  }),
  rule({
    code: "guarantor_net_worth",
    name: "Net worth statement — guarantor",
    documentTypeCode: "net_worth_statement",
    scope: "party",
    partyRoles: ["guarantor"],
    partyKind: "person",
    applicability: "optional",
    conditions: [customerProductNotIn(...ASSET_ONLY_PRODUCTS)],
    order: ORDER.income,
    notes: "A guarantee is worth what the guarantor is worth.",
  }),

  // -------------------------------------------------------------------------
  // Existing obligations — only when there are any. A case with no borrowing
  // history generates no rows here at all (ADR-010).
  // -------------------------------------------------------------------------
  rule({
    code: "obligations_loan_statement",
    name: "Existing loan statement",
    documentTypeCode: "existing_loan_statement",
    scope: "party",
    partyRoles: INCOME_ROLES,
    conditions: [
      isTrue("party.has_existing_obligations"),
      customerProductNotIn(...ASSET_ONLY_PRODUCTS),
    ],
    order: ORDER.obligations,
    notes:
      "Repayment track on every live facility — the obligations half of FOIR. " +
      "Gold and securities are not FOIR-assessed, so they do not ask.",
  }),
  rule({
    code: "takeover_loan_statement",
    name: "Existing loan statement — takeover",
    documentTypeCode: "existing_loan_statement",
    scope: "party",
    partyRoles: ["applicant"],
    conditions: [productIn(...TAKEOVER_PRODUCTS)],
    order: ORDER.obligations,
    notes: "A balance transfer is entirely about the loan being transferred.",
  }),
  rule({
    code: "takeover_foreclosure_letter",
    name: "Foreclosure letter — takeover",
    documentTypeCode: "foreclosure_letter",
    scope: "case",
    stage: "ready_for_submission",
    conditions: [productIn(...TAKEOVER_PRODUCTS)],
    order: ORDER.obligations,
    notes: "Dated and short-lived; asking for it on day two wastes it.",
  }),

  // -------------------------------------------------------------------------
  // The borrowing firm — an organisation on the file in its own right.
  // -------------------------------------------------------------------------
  rule({
    code: "firm_pan",
    name: "Business PAN",
    documentTypeCode: "org_pan",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    order: ORDER.firm,
  }),
  rule({
    code: "firm_address_proof",
    name: "Business address proof",
    documentTypeCode: "org_address_proof",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    order: ORDER.firm,
    notes: "Utility bill or lease, dated within three months.",
  }),
  rule({
    code: "firm_business_proof",
    name: "Business registration proof",
    documentTypeCode: "business_proof",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    order: ORDER.firm,
    notes: "Shop & Establishment, trade licence, or the constitution document itself.",
  }),
  rule({
    code: "firm_bank_statement",
    name: "Business bank statement",
    documentTypeCode: "org_bank_statement",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    financialYears: 1,
    order: ORDER.firm,
    notes: "Twelve months of the current account — the working-capital assessment.",
  }),
  rule({
    code: "firm_itr",
    name: "Business income tax return",
    documentTypeCode: "org_itr",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    financialYears: 2,
    order: ORDER.firm,
  }),
  rule({
    code: "firm_balance_sheet",
    name: "Balance sheet",
    documentTypeCode: "balance_sheet",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    financialYears: 2,
    order: ORDER.firm,
  }),
  rule({
    code: "firm_profit_and_loss",
    name: "Profit and loss statement",
    documentTypeCode: "profit_and_loss",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    financialYears: 2,
    order: ORDER.firm,
  }),
  rule({
    code: "firm_audit_report",
    name: "Audit report — audited constitutions",
    documentTypeCode: "audit_report",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    financialYears: 2,
    conditions: [constitutionIn("llp", "private_limited", "public_limited")],
    order: ORDER.firm,
    notes: "A proprietorship below the audit threshold has none, and is not asked.",
  }),

  // -------------------------------------------------------------------------
  // GST — only when the business is actually registered. The single clearest
  // dependency in the brief: no registration, no rows.
  // -------------------------------------------------------------------------
  rule({
    code: "gst_certificate_firm",
    name: "GST registration certificate",
    documentTypeCode: "gst_certificate",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    conditions: [isTrue("party.is_gst_registered")],
    order: ORDER.firm,
  }),
  rule({
    code: "gst_returns_firm",
    name: "GST returns",
    documentTypeCode: "gst_returns",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    financialYears: 1,
    conditions: [isTrue("party.is_gst_registered")],
    order: ORDER.firm,
    notes: "GSTR-3B and GSTR-1 for the last financial year — the turnover the NBFC prices off.",
  }),
  rule({
    code: "gst_certificate_individual",
    name: "GST registration certificate — GST-registered individual borrower",
    documentTypeCode: "gst_certificate",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    conditions: [
      isTrue("case.is_gst_registered"),
      fact("case.has_borrower_firm", "is_false"),
      employmentIn("self_employed", "business_owner"),
    ],
    order: ORDER.firm,
    notes: "A GST-registered proprietor borrowing in their own name.",
  }),
  rule({
    code: "gst_returns_individual",
    name: "GST returns — GST-registered individual borrower",
    documentTypeCode: "gst_returns",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    financialYears: 1,
    conditions: [
      isTrue("case.is_gst_registered"),
      fact("case.has_borrower_firm", "is_false"),
      employmentIn("self_employed", "business_owner"),
    ],
    order: ORDER.firm,
    notes:
      "The audit found the certificate rule above had no returns counterpart, so a " +
      "registered proprietor was asked to prove registration and never asked for the " +
      "turnover the registration produces.",
  }),

  // -------------------------------------------------------------------------
  // GST, second source: the PRODUCT's own declaration.
  //
  // THE BUG THIS FIXES. Every rule above waits for somebody to tick "GST
  // registered", which starts life undefined and stays that way until asked.
  // So a Business Loan created this morning generated NO GST rows at all —
  // the gap reported from live testing.
  //
  // Meanwhile the catalogue already carries the answer: eight business
  // products and Commercial LAP declare `gstRequirement: mandatory`
  // (ADR-032, Database/migrations/0016), and `case.gst_requirement` has been
  // a resolvable fact since the engine shipped with nothing reading it. These
  // rules read it.
  //
  // Deliberately SEPARATE rules rather than an extra `match: "any"` condition
  // on the ones above, because those carry compound `all` conditions that
  // `any` would wreck. The engine merges rules landing on the same document
  // for the same subject to the stricter reading, so a registered firm on a
  // GST-mandatory product gets one row, not two.
  // -------------------------------------------------------------------------
  rule({
    code: "gst_certificate_firm_by_product",
    name: "GST registration certificate — product requires GST",
    documentTypeCode: "gst_certificate",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    conditions: [gstRequiredByProduct()],
    order: ORDER.firm,
    notes: "Asked because the product cannot be assessed without GST, not because anyone ticked a box.",
  }),
  rule({
    code: "gst_returns_firm_by_product",
    name: "GST returns — product requires GST",
    documentTypeCode: "gst_returns",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    financialYears: 1,
    conditions: [gstRequiredByProduct()],
    order: ORDER.firm,
    notes: "GSTR-3B and GSTR-1 for the last financial year — the turnover the NBFC prices off.",
  }),
  rule({
    code: "gst_certificate_individual_by_product",
    name: "GST registration certificate — product requires GST, no firm on the file",
    documentTypeCode: "gst_certificate",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    conditions: [
      gstRequiredByProduct(),
      fact("case.has_borrower_firm", "is_false"),
      employmentIn("self_employed", "business_owner"),
    ],
    order: ORDER.firm,
    notes: "The proprietor case: the business is the person, and the product still needs GST.",
  }),
  rule({
    code: "gst_returns_individual_by_product",
    name: "GST returns — product requires GST, no firm on the file",
    documentTypeCode: "gst_returns",
    scope: "party",
    partyRoles: INCOME_ROLES,
    partyKind: "person",
    financialYears: 1,
    conditions: [
      gstRequiredByProduct(),
      fact("case.has_borrower_firm", "is_false"),
      employmentIn("self_employed", "business_owner"),
    ],
    order: ORDER.firm,
  }),

  // -------------------------------------------------------------------------
  // Constitution documents. Driven by what the entity IS, not by what it is
  // borrowing — which is how lenders actually ask.
  // -------------------------------------------------------------------------
  rule({
    code: "constitution_partnership_deed",
    name: "Partnership deed",
    documentTypeCode: "partnership_deed",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    conditions: [constitutionIn("partnership")],
    order: ORDER.constitution,
  }),
  rule({
    code: "constitution_llp_agreement",
    name: "LLP agreement",
    documentTypeCode: "llp_agreement",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    conditions: [constitutionIn("llp")],
    order: ORDER.constitution,
  }),
  rule({
    code: "constitution_incorporation",
    name: "Certificate of incorporation",
    documentTypeCode: "certificate_of_incorporation",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    conditions: [constitutionIn("llp", "private_limited", "public_limited")],
    order: ORDER.constitution,
  }),
  rule({
    code: "constitution_moa_aoa",
    name: "MOA and AOA",
    documentTypeCode: "moa_aoa",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    conditions: [constitutionIn("private_limited", "public_limited")],
    order: ORDER.constitution,
  }),
  rule({
    code: "constitution_board_resolution",
    name: "Board resolution to borrow",
    documentTypeCode: "board_resolution",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    conditions: [constitutionIn("private_limited", "public_limited", "trust_society", "llp")],
    order: ORDER.constitution,
    notes:
      "A company borrows by resolution. Without it nobody on the file has authority. " +
      "The audit added LLP: designated partners resolve to borrow exactly as a board " +
      "does, and the first pack asked an LLP for its agreement but never for the " +
      "authority to sign. A partnership is deliberately absent — its deed names the " +
      "authorised partners itself.",
  }),
  rule({
    code: "constitution_director_list",
    name: "List of directors or partners",
    documentTypeCode: "list_of_directors",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    conditions: [constitutionIn("partnership", "llp", "private_limited", "public_limited")],
    order: ORDER.constitution,
  }),
  rule({
    code: "constitution_shareholding",
    name: "Shareholding pattern",
    documentTypeCode: "shareholding_pattern",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    applicability: "optional",
    conditions: [constitutionIn("private_limited", "public_limited")],
    order: ORDER.constitution,
  }),
  rule({
    code: "constitution_trust_deed",
    name: "Trust deed",
    documentTypeCode: "trust_deed",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    conditions: [constitutionIn("trust_society")],
    order: ORDER.constitution,
  }),
  rule({
    code: "constitution_society_registration",
    name: "Society registration certificate",
    documentTypeCode: "society_registration",
    scope: "party",
    partyRoles: ["borrower_firm"],
    partyKind: "organisation",
    applicability: "optional",
    conditions: [constitutionIn("trust_society")],
    order: ORDER.constitution,
  }),

  // -------------------------------------------------------------------------
  // Business-product specifics.
  // -------------------------------------------------------------------------
  rule({
    code: "business_udyam_scheme",
    name: "Udyam registration — scheme-linked products",
    documentTypeCode: "udyam_certificate",
    scope: "case",
    conditions: [productIn("bl_msme_cgtmse", "bl_mudra", "bl_machinery")],
    order: ORDER.business,
    notes: "CGTMSE and PMMY are only available to a registered MSME. No Udyam, no scheme.",
  }),
  rule({
    code: "business_udyam_general",
    name: "Udyam registration — other business products",
    documentTypeCode: "udyam_certificate",
    scope: "case",
    applicability: "optional",
    conditions: [
      customerProductIn("business_loan"),
      productNotIn("bl_msme_cgtmse", "bl_mudra", "bl_machinery"),
    ],
    order: ORDER.business,
  }),
  rule({
    code: "business_stock_statement",
    name: "Stock and book debts statement",
    documentTypeCode: "stock_statement",
    scope: "case",
    conditions: [fact("case.security_type_code", "equals", "stock_book_debts")],
    order: ORDER.business,
    notes: "The security itself on a cash-credit limit — assessed, then monitored monthly.",
  }),
  rule({
    code: "business_debtors_creditors",
    name: "Debtors and creditors statement",
    documentTypeCode: "debtors_creditors_statement",
    scope: "case",
    conditions: [productIn("bl_working_capital", "bl_overdraft")],
    order: ORDER.business,
    notes: "Ageing of receivables and payables — the working-capital cycle.",
  }),
  rule({
    code: "business_project_report",
    name: "Project report",
    documentTypeCode: "project_report",
    scope: "case",
    conditions: [productIn("bl_term_loan", "bl_msme_cgtmse")],
    order: ORDER.business,
    notes: "A term loan funds a purpose. The report is that purpose, costed.",
  }),
  rule({
    code: "business_machinery_quotation",
    name: "Machinery quotation",
    documentTypeCode: "machinery_quotation",
    scope: "case",
    conditions: [productIn("bl_machinery")],
    order: ORDER.business,
  }),
  rule({
    code: "business_contract_or_tender",
    name: "Contract or tender document",
    documentTypeCode: "contract_or_tender",
    scope: "case",
    conditions: [productIn("bl_non_fund_based")],
    order: ORDER.business,
    notes: "A bank guarantee is issued against an obligation. This is the obligation.",
  }),
  rule({
    code: "business_invoices",
    name: "Invoices or bills",
    documentTypeCode: "invoice_bills",
    scope: "case",
    conditions: [productIn("bl_bill_discounting")],
    order: ORDER.business,
  }),
  rule({
    code: "business_buyer_acceptance",
    name: "Buyer acceptance",
    documentTypeCode: "buyer_acceptance",
    scope: "case",
    conditions: [productIn("bl_bill_discounting")],
    order: ORDER.business,
    notes: "Discounting an invoice the buyer has not accepted is lending against hope.",
  }),

  // -------------------------------------------------------------------------
  // Property. Every rule here is property-scoped, so a case with no property
  // on file produces none of them — the collateral dependency, for free.
  //
  // The Tamil Nadu core: Patta / Chitta, parent document, EC. Generic
  // checklists list "title deed" and stop; a Coimbatore file does not clear
  // legal without all three.
  // -------------------------------------------------------------------------
  rule({
    code: "property_sale_deed",
    name: "Sale deed / title deed",
    documentTypeCode: "sale_deed",
    scope: "property",
    order: ORDER.property,
  }),
  rule({
    code: "property_parent_document",
    name: "Parent document (title chain)",
    documentTypeCode: "parent_document",
    scope: "property",
    order: ORDER.property,
    notes: "Thirteen to thirty years of chain, depending on the lender's legal panel.",
  }),
  rule({
    code: "property_patta_chitta",
    name: "Patta / Chitta",
    documentTypeCode: "patta_chitta",
    scope: "property",
    conditions: [fact("property.type", "not_in", "apartment")],
    order: ORDER.property,
    notes:
      "Tamil Nadu revenue ownership record. An apartment on undivided share is the " +
      "one common case where the patta sits with the land, not the buyer.",
  }),
  rule({
    code: "property_encumbrance_certificate",
    name: "Encumbrance certificate",
    documentTypeCode: "encumbrance_cert",
    scope: "property",
    order: ORDER.property,
    notes: "Villangam, from the Sub-Registrar. Thirteen years is the usual ask.",
  }),
  rule({
    code: "property_tax_receipt",
    name: "Property tax receipt",
    documentTypeCode: "property_tax_receipt",
    scope: "property",
    order: ORDER.property,
  }),
  rule({
    code: "property_approved_plan",
    name: "Approved building plan",
    documentTypeCode: "approved_plan",
    scope: "property",
    conditions: [productIn(...PLAN_PRODUCTS)],
    order: ORDER.property,
  }),
  rule({
    code: "property_layout_approval",
    name: "Layout approval (DTCP / CMDA / local body)",
    documentTypeCode: "layout_approval",
    scope: "property",
    conditions: [fact("property.type", "in", "plot"), productIn("hl_plot_purchase", "hl_plot_construction")],
    order: ORDER.property,
    notes: "An unapproved layout is the most common reason a Tamil Nadu plot file is declined.",
  }),
  rule({
    code: "property_sale_agreement",
    name: "Sale agreement",
    documentTypeCode: "sale_agreement",
    scope: "property",
    conditions: [productIn(...PURCHASE_PRODUCTS)],
    order: ORDER.property,
  }),
  rule({
    code: "property_builder_noc",
    name: "Builder NOC / allotment letter",
    documentTypeCode: "builder_noc",
    scope: "property",
    applicability: "optional",
    conditions: [productIn("hl_purchase", "hl_affordable")],
    order: ORDER.property,
  }),
  rule({
    code: "property_occupancy_certificate",
    name: "Occupancy certificate",
    documentTypeCode: "occupancy_certificate",
    scope: "property",
    applicability: "optional",
    conditions: [productIn("hl_purchase", "hl_affordable", "hl_balance_transfer")],
    order: ORDER.property,
  }),
  rule({
    code: "property_own_contribution",
    name: "Own contribution / margin money proof",
    documentTypeCode: "own_contribution_proof",
    scope: "case",
    stage: "ready_for_submission",
    conditions: [productIn(...PURCHASE_PRODUCTS)],
    order: ORDER.property,
    notes:
      "The audit added this. Margin is 10–25% by ticket size and no lender disburses " +
      "without evidence the borrower has paid theirs — a builder's receipt, or the " +
      "transfer that funded it. Due at submission, not on day two, because there is " +
      "usually nothing to show until a property and a price exist.",
  }),
  rule({
    code: "property_legal_opinion",
    name: "Legal opinion",
    documentTypeCode: "legal_opinion",
    scope: "property",
    stage: "ready_for_submission",
    order: ORDER.property,
    notes: "Produced by the lender's panel advocate — not due before a lender is chosen.",
  }),
  rule({
    code: "property_valuation_report",
    name: "Valuation report",
    documentTypeCode: "valuation_report",
    scope: "property",
    stage: "ready_for_submission",
    order: ORDER.property,
    notes:
      "Demanding a valuation on day two, before a property is chosen, makes the " +
      "checklist wrong and the progress bar useless (Requirements and Progress, Part 3).",
  }),
  rule({
    code: "property_lease_deed",
    name: "Registered lease deed — lease rental discounting",
    documentTypeCode: "lease_deed",
    scope: "property",
    conditions: [productIn("lap_lrd")],
    order: ORDER.property,
  }),
  rule({
    code: "property_tenant_kyc",
    name: "Tenant KYC — lease rental discounting",
    documentTypeCode: "tenant_kyc",
    scope: "case",
    conditions: [productIn("lap_lrd")],
    order: ORDER.property,
    notes: "LRD is underwritten on the tenant's covenant, not the landlord's income.",
  }),

  // -------------------------------------------------------------------------
  // Construction — appears only on a construction product, and the progress
  // report only once building has actually started.
  // -------------------------------------------------------------------------
  rule({
    code: "construction_estimate",
    name: "Construction estimate",
    documentTypeCode: "construction_estimate",
    scope: "property",
    conditions: [productIn(...CONSTRUCTION_PRODUCTS)],
    order: ORDER.construction,
    notes: "Costed by an engineer or architect. Drives the staged disbursement schedule.",
  }),
  rule({
    code: "construction_progress_report",
    name: "Construction progress report",
    documentTypeCode: "construction_progress_report",
    scope: "property",
    conditions: [
      productIn(...CONSTRUCTION_PRODUCTS),
      fact("case.construction_stage", "not_in", "not_started"),
      fact("case.construction_stage", "exists"),
    ],
    order: ORDER.construction,
    notes:
      "Each further tranche is released against progress. Nothing to report before " +
      "the first brick, so the requirement does not exist yet.",
  }),

  // -------------------------------------------------------------------------
  // Vehicle.
  // -------------------------------------------------------------------------
  rule({
    code: "vehicle_quotation",
    name: "Vehicle quotation / proforma invoice",
    documentTypeCode: "vehicle_quotation",
    scope: "case",
    conditions: [productIn("vl_new_car", "vl_two_wheeler", "vl_commercial_vehicle")],
    order: ORDER.vehicle,
  }),
  rule({
    code: "vehicle_rc",
    name: "Vehicle registration certificate — used vehicle",
    documentTypeCode: "vehicle_rc",
    scope: "case",
    conditions: [productIn("vl_used_car")],
    order: ORDER.vehicle,
  }),
  rule({
    code: "vehicle_valuation",
    name: "Vehicle valuation — used vehicle",
    documentTypeCode: "vehicle_valuation",
    scope: "case",
    conditions: [productIn("vl_used_car")],
    order: ORDER.vehicle,
    notes: "Tenure is capped by the vehicle's age, so the valuation is also an eligibility input.",
  }),
  rule({
    code: "vehicle_route_permit",
    name: "Route permit — commercial vehicle",
    documentTypeCode: "route_permit",
    scope: "case",
    conditions: [productIn("vl_commercial_vehicle")],
    order: ORDER.vehicle,
  }),
  rule({
    code: "vehicle_insurance",
    name: "Vehicle insurance",
    documentTypeCode: "vehicle_insurance",
    scope: "case",
    stage: "ready_for_submission",
    conditions: [customerProductIn("vehicle_loan")],
    order: ORDER.vehicle,
  }),

  // -------------------------------------------------------------------------
  // Gold — documented by the security. Nothing else is asked, and that is the
  // product.
  // -------------------------------------------------------------------------
  rule({
    code: "gold_appraisal_note",
    name: "Gold appraisal note",
    documentTypeCode: "gold_appraisal_note",
    scope: "case",
    conditions: [customerProductIn("gold_loan")],
    order: ORDER.gold,
    notes: "The appraiser's weight, purity and valuation. The whole underwriting.",
  }),

  // -------------------------------------------------------------------------
  // Education.
  // -------------------------------------------------------------------------
  rule({
    code: "education_admission_letter",
    name: "Admission letter",
    documentTypeCode: "admission_letter",
    scope: "case",
    conditions: [customerProductIn("education_loan")],
    order: ORDER.education,
  }),
  rule({
    code: "education_fee_structure",
    name: "Fee structure",
    documentTypeCode: "fee_structure",
    scope: "case",
    conditions: [customerProductIn("education_loan")],
    order: ORDER.education,
  }),
  rule({
    code: "education_academic_records",
    name: "Academic records",
    documentTypeCode: "academic_records",
    scope: "case",
    conditions: [customerProductIn("education_loan")],
    order: ORDER.education,
  }),
  rule({
    code: "education_passport",
    name: "Passport — overseas education",
    documentTypeCode: "passport",
    scope: "party",
    partyRoles: ["applicant"],
    partyKind: "person",
    conditions: [productIn("el_abroad")],
    order: ORDER.education,
  }),
  rule({
    code: "education_visa",
    name: "Visa — overseas education",
    documentTypeCode: "visa",
    scope: "party",
    partyRoles: ["applicant"],
    partyKind: "person",
    stage: "ready_for_submission",
    conditions: [productIn("el_abroad")],
    order: ORDER.education,
    notes: "Often granted after sanction. Due late, never treated as missing early.",
  }),

  // -------------------------------------------------------------------------
  // Loan against securities.
  // -------------------------------------------------------------------------
  rule({
    code: "securities_demat_statement",
    name: "Demat / portfolio statement",
    documentTypeCode: "demat_statement",
    scope: "case",
    conditions: [productIn("las_shares_mf")],
    order: ORDER.securities,
  }),
  rule({
    code: "securities_fd_receipt",
    name: "Fixed deposit receipt",
    documentTypeCode: "fd_receipt",
    scope: "case",
    conditions: [productIn("las_fd")],
    order: ORDER.securities,
  }),

  // -------------------------------------------------------------------------
  // Case-level paperwork.
  // -------------------------------------------------------------------------
  rule({
    code: "case_application_form",
    name: "Application form",
    documentTypeCode: "application_form",
    scope: "case",
    order: ORDER.caseLevel,
  }),
  rule({
    code: "case_login_form",
    name: "Login form",
    documentTypeCode: "login_form",
    scope: "case",
    stage: "ready_for_submission",
    order: ORDER.caseLevel,
    notes: "The lender's own form. Not fillable until the lender is chosen.",
  }),
  rule({
    code: "case_nach_mandate",
    name: "NACH mandate / security cheques",
    documentTypeCode: "nach_mandate",
    scope: "case",
    stage: "ready_for_submission",
    conditions: [customerProductNotIn("gold_loan")],
    order: ORDER.caseLevel,
  }),
];

/** Lookup by rule code, for the "why is this being asked for?" panel. */
export function findRule(code: string): RequirementRule | undefined {
  return DEFAULT_REQUIREMENT_RULES.find((rule) => rule.code === code);
}

/** Every document type code the default pack can ask for. */
export function defaultRuleDocumentTypeCodes(): string[] {
  return [...new Set(DEFAULT_REQUIREMENT_RULES.map((rule) => rule.documentTypeCode))].sort();
}
