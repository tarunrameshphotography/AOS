/**
 * A bank submission's own status lifecycle (Phase 5 — loan outcome tracking).
 *
 * Different axis from the case stage (ADR-004): the case stage is derived
 * from the aggregate of every submission's outcome
 * (`@domain/case/transitions.js`'s `deriveSystemStagePath`); this module is
 * the lattice ONE submission moves through, bank by bank, independent of
 * every other bank on the same case.
 *
 * Source of the shape: the Phase 5 brief's workflow diagram —
 *
 *   submitted -> under_process <-> query_raised -> eligibility_received
 *     -> { sanctioned -> disbursed, rejected }
 *
 * plus `withdrawn`, reachable from any live, non-terminal status (including
 * `not_submitted` — a draft bank withdrawn before ever being sent, which is
 * exactly what accepting a competing offer does under BR-025).
 *
 * `query_raised` and the return to `under_process` are deliberately not
 * reachable through the generic status update this table governs — they
 * carry a question/answer that belongs on `submission_query`
 * (`Backend/submissions.ts`'s `raiseQuery`/`answerQuery`), which write this
 * same status column but ask a narrower question with its own text.
 */

export type SubmissionStatus =
  | "not_submitted"
  | "submitted"
  | "under_process"
  | "query_raised"
  | "eligibility_received"
  | "sanctioned"
  | "rejected"
  | "withdrawn"
  | "disbursed";

export const SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  "not_submitted",
  "submitted",
  "under_process",
  "query_raised",
  "eligibility_received",
  "sanctioned",
  "rejected",
  "withdrawn",
  "disbursed",
];

/** Statuses `updateSubmissionStatus` (the generic action) may be asked to set.
 * `not_submitted` is set only by creating a submission; `query_raised` and the
 * `query_raised -> under_process` return are set only by
 * `raiseQuery`/`answerQuery`. */
export const GENERIC_TARGET_STATUSES: readonly SubmissionStatus[] = [
  "under_process",
  "eligibility_received",
  "sanctioned",
  "rejected",
  "withdrawn",
  "disbursed",
];

const LEGAL_TRANSITIONS: Record<SubmissionStatus, readonly SubmissionStatus[]> = {
  not_submitted: ["withdrawn"],
  submitted: ["under_process", "rejected", "withdrawn"],
  under_process: ["query_raised", "eligibility_received", "rejected", "withdrawn"],
  query_raised: ["under_process"],
  eligibility_received: ["sanctioned", "rejected", "withdrawn"],
  sanctioned: ["disbursed", "withdrawn"],
  rejected: [],
  withdrawn: [],
  disbursed: [],
};

/** Whether a submission may move from `from` to `to` at all — the shape of
 * the lattice, independent of the extra business rules (a rejection reason,
 * an offer on file) `Backend/submissions.ts` layers on top for specific
 * targets. */
export function canTransitionSubmission(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Statuses a submission is "still open" at — not yet rejected, withdrawn or
 * disbursed. Matches the set BR-025's competing-submission withdrawal acts
 * on (`Frontend/src/fake/store.ts`'s `acceptOffer`) and what a "Withdraw"
 * action should offer on screen. */
const TERMINAL_STATUSES: readonly SubmissionStatus[] = ["rejected", "withdrawn", "disbursed"];

export function isLiveSubmissionStatus(status: SubmissionStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}
