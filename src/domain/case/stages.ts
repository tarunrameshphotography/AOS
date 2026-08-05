/**
 * Case lifecycle stages.
 *
 * Source of truth: PRD/Loan Lifecycle.md
 *
 * A case occupies exactly one stage at all times (BR-014). Stages describe the
 * *customer's journey* and are a different axis from submission status, which
 * describes one file at one bank (ADR-004).
 *
 * These constants are the single definition of the stage vocabulary. Database
 * migrations and UI both import from here rather than restating the list, so a
 * stage cannot be added in one place and forgotten in another.
 */

export const CASE_STAGES = [
  "new",
  "contacted",
  "appointment_fixed",
  "documents_pending",
  "ready_for_submission",
  "submitted",
  "sanctioned",
  "disbursed",
  "closed",
  "lost",
] as const;

export type CaseStage = (typeof CASE_STAGES)[number];

/** Stages from which a case never moves again, except by reopening from `lost`. */
export const TERMINAL_STAGES = ["closed", "lost"] as const satisfies readonly CaseStage[];

export type TerminalStage = (typeof TERMINAL_STAGES)[number];

export function isTerminalStage(stage: CaseStage): stage is TerminalStage {
  return (TERMINAL_STAGES as readonly CaseStage[]).includes(stage);
}

/**
 * The ordered progression a case moves through. Terminal stages are absent by
 * design (ADR-023).
 *
 * `closed` and `lost` are outcomes, not positions. Including them would give
 * `lost` the highest ordinal and make every requirement look due on a dead case
 * — a wrong number that fails silently rather than loudly.
 */
export const CASE_STAGE_PROGRESSION = [
  "new",
  "contacted",
  "appointment_fixed",
  "documents_pending",
  "ready_for_submission",
  "submitted",
  "sanctioned",
  "disbursed",
] as const satisfies readonly CaseStage[];

export type ProgressionStage = (typeof CASE_STAGE_PROGRESSION)[number];

/**
 * How far along the progression a stage sits, for comparisons such as "is this
 * requirement due yet?".
 *
 * Returns `null` for terminal stages: asking whether a requirement is due on a
 * lost case is not a question with an answer, and callers must handle that
 * rather than receive a plausible-looking number.
 */
export function stageOrdinal(stage: CaseStage): number | null {
  const index = (CASE_STAGE_PROGRESSION as readonly CaseStage[]).indexOf(stage);
  return index === -1 ? null : index;
}

/**
 * Human-readable labels. Kept beside the values deliberately: a stage added
 * without a label is a compile error rather than a screen showing
 * "ready_for_submission" to a telecaller.
 */
export const CASE_STAGE_LABELS: Record<CaseStage, string> = {
  new: "New",
  contacted: "Contacted",
  appointment_fixed: "Appointment Fixed",
  documents_pending: "Documents Pending",
  ready_for_submission: "Ready for Submission",
  submitted: "Submitted",
  sanctioned: "Sanctioned",
  disbursed: "Disbursed",
  closed: "Closed",
  lost: "Lost",
};

/**
 * Reasons a case can be lost. Controlled list, not free text — a rejection
 * reason buried in a note is a fact the company cannot learn from
 * (Product Principles #11).
 */
export const LOST_REASONS = [
  "rate_too_high",
  "sanctioned_elsewhere",
  "customer_not_eligible",
  "documents_unavailable",
  "property_issue",
  "customer_postponed",
  "unreachable",
  "not_interested",
  "duplicate_case",
] as const;

export type LostReason = (typeof LOST_REASONS)[number];

export const LOST_REASON_LABELS: Record<LostReason, string> = {
  rate_too_high: "Rate too high",
  sanctioned_elsewhere: "Sanctioned elsewhere",
  customer_not_eligible: "Customer not eligible",
  documents_unavailable: "Documents unavailable",
  property_issue: "Property issue",
  customer_postponed: "Customer postponed",
  unreachable: "Unreachable",
  not_interested: "Not interested",
  duplicate_case: "Duplicate case",
};
