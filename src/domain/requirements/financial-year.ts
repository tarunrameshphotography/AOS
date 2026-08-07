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
 *
 * WHICH document types recur per year is not decided here — that is a property
 * of the document, and it lives with the document in document-catalogue.ts
 * (`defaultFinancialYears`, `isFinancialYearScoped`). This file only knows what
 * a financial year IS.
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

