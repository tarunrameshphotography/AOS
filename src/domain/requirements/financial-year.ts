/**
 * Financial-year computation for period-scoped document requirements.
 *
 * Source of truth: PRD/Data Model.md (`document.period_start` /
 * `document.period_end`), extended to `document_requirement` — see
 * Database/migrations/0011.
 *
 * India's financial year runs 1 April to 31 March. A requirement for "GST
 * Returns" or "Income Tax Return" is not one open-ended ask; it is a specific
 * year's filing, and a bank asking for the last two years' returns needs two
 * distinguishable requirement rows, not one row that either of two different
 * years' documents can satisfy.
 *
 * All dates are computed in UTC so a financial year boundary does not shift
 * with the machine's local timezone — the same reason `document.period_start`
 * is a plain `date`, not a `timestamptz`.
 */

export interface FinancialYear {
  /** ISO date, inclusive. 1 April. */
  readonly startDate: string;
  /** ISO date, inclusive. 31 March of the following calendar year. */
  readonly endDate: string;
  /** "2024-25" */
  readonly label: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The calendar year a financial year starts in, e.g. 2024 for "2024-25". */
export function financialYearStartYear(date: Date): number {
  const month = date.getUTCMonth(); // 0-based; April = 3
  const year = date.getUTCFullYear();
  return month >= 3 ? year : year - 1;
}

export function financialYearLabel(startYear: number): string {
  return `${startYear}-${pad2((startYear + 1) % 100)}`;
}

export function financialYearFromStartYear(startYear: number): FinancialYear {
  return {
    startDate: `${startYear}-04-01`,
    endDate: `${startYear + 1}-03-31`,
    label: financialYearLabel(startYear),
  };
}

export function financialYearOf(date: Date): FinancialYear {
  return financialYearFromStartYear(financialYearStartYear(date));
}

/**
 * The `count` most recent financial years as of `asOf`, most recent first —
 * index 0 is the (possibly still-open) current financial year.
 */
export function recentFinancialYears(count: number, asOf: Date = new Date()): FinancialYear[] {
  if (count < 1) return [];
  const currentStartYear = financialYearStartYear(asOf);
  return Array.from({ length: count }, (_, offset) =>
    financialYearFromStartYear(currentStartYear - offset),
  );
}

/**
 * Document types whose requirement is scoped per financial year, keyed by
 * `document_type.code`, with the number of trailing years requested by
 * default when a case first generates requirements.
 *
 * SINCE THE RULE ENGINE (Milestone 9, ADR-035) the authoritative trailing-year
 * count for a generated requirement is `RequirementRule.financialYears` — a
 * configurable number on an editable rule, not a constant. This map remains
 * for two jobs the rules cannot do:
 *
 *   1. `isFinancialYearScoped` — the UI's "is this document type tracked per
 *      year, and may a user request another year of it?" question, which is a
 *      property of the document type rather than of any one rule.
 *   2. A fallback count for a requirement generated without a rule (an
 *      explicitly-requested extra year, or a row that predates the engine).
 *
 * **These counts are a starting assumption, not a finding** — real per-lender
 * practice varies (the same caveat `rejection_reason`'s seed data carries in
 * Database/migrations/0009).
 *
 * A document type absent from this map is period-scoped in the ordinary
 * sense (`document_type.requires_period`) without being multiplied per
 * year — a bank statement's *requirement* still asks for one rolling window,
 * even though the *document* uploaded against it now also carries a period.
 * Only the five types this feature was scoped for are financial-year-scoped
 * requirements; the rest are unchanged.
 */
export const FINANCIAL_YEAR_DOCUMENT_TYPES: Readonly<Record<string, number>> = {
  itr: 2,
  org_itr: 2,
  gst_returns: 1,
  balance_sheet: 2,
  profit_and_loss: 2,
  bank_statement: 1,
  org_bank_statement: 1,
  // Added with the rule engine (Milestone 9): a lender asking for two years'
  // Form 16 or audited accounts means two distinguishable rows, for exactly
  // the reason ITR did.
  form_16: 2,
  audit_report: 2,
};

export function isFinancialYearScoped(documentTypeCode: string): boolean {
  return documentTypeCode in FINANCIAL_YEAR_DOCUMENT_TYPES;
}
