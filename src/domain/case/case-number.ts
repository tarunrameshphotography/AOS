/**
 * Case numbers — the human-readable business identifier.
 *
 * Source of truth: ADR-024
 *
 * `AL-2026-00042`. Quoted on the phone, printed on a login form, and nothing
 * joins on it. The case's identity is its UUID; this exists for humans.
 *
 * The format is a constant, deliberately not configuration. A configurable
 * format is the mechanism by which loan type or branch ends up encoded in the
 * number, and an encoded number cannot survive a case whose loan product changes
 * mid-case — which is a supported operation (`Workflow.md`).
 */

export const CASE_NUMBER_PREFIX = "AL";

/** Zero-padded width of the within-year counter. Five digits, so `00042`. */
export const CASE_NUMBER_SEQUENCE_WIDTH = 5;

/**
 * Canonical form. Anchored, and the year is four digits so that a two-digit
 * year can never be mistaken for a short sequence.
 */
export const CASE_NUMBER_PATTERN = /^AL-(\d{4})-(\d{5,})$/;

export interface CaseNumberParts {
  readonly year: number;
  readonly sequence: number;
}

/**
 * Render a case number. The sequence is padded to five digits and *not* truncated
 * beyond it — a year that somehow exceeds 99,999 cases produces a six-digit
 * number rather than a collision.
 */
export function formatCaseNumber({ year, sequence }: CaseNumberParts): string {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new RangeError(`Case number year must be a four-digit year, received ${year}.`);
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`Case number sequence must be a positive integer, received ${sequence}.`);
  }

  const padded = String(sequence).padStart(CASE_NUMBER_SEQUENCE_WIDTH, "0");
  return `${CASE_NUMBER_PREFIX}-${year}-${padded}`;
}

/** Parse a canonical case number. Returns null rather than throwing — callers are parsing user input. */
export function parseCaseNumber(value: string): CaseNumberParts | null {
  const match = CASE_NUMBER_PATTERN.exec(value.trim().toUpperCase());
  if (!match) {
    return null;
  }

  const [, year, sequence] = match;
  if (year === undefined || sequence === undefined) {
    return null;
  }

  return { year: Number(year), sequence: Number(sequence) };
}

/**
 * Normalise what somebody actually typed into a case number, if it plausibly is
 * one.
 *
 * People quote these back partially and inconsistently: `AL-2026-00042`,
 * `2026-00042`, `00042`, `42`, and — from the display handle this format
 * replaces — `#42`. All must find the case. A bare sequence needs a year, which
 * the caller supplies as the search context; defaulting to the current year is
 * right because a number quoted without a year is almost always a live case.
 *
 * Returns null when the input is not case-number-shaped at all, so the caller
 * falls through to ordinary text search rather than showing no results.
 */
export function resolveCaseNumberInput(input: string, contextYear: number): string | null {
  const cleaned = input.trim().toUpperCase().replace(/^#/, "");
  if (cleaned === "") {
    return null;
  }

  const canonical = parseCaseNumber(cleaned);
  if (canonical) {
    return formatCaseNumber(canonical);
  }

  const yearAndSequence = /^(\d{4})-(\d+)$/.exec(cleaned);
  if (yearAndSequence) {
    const [, year, sequence] = yearAndSequence;
    return formatCaseNumber({ year: Number(year), sequence: Number(sequence) });
  }

  // A bare number. Four digits is ambiguous — `2026` is as likely a year as a
  // sequence — so it is treated as a sequence, because somebody searching a year
  // alone is not looking for one case.
  const bare = /^(\d+)$/.exec(cleaned);
  if (bare?.[1] !== undefined) {
    const sequence = Number(bare[1]);
    return sequence >= 1 ? formatCaseNumber({ year: contextYear, sequence }) : null;
  }

  return null;
}
