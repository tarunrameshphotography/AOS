/**
 * Case stage transitions and their guards.
 *
 * Source of truth: PRD/Workflow.md — "Case stage transitions"
 *
 * This module is pure. It decides whether a move is legal and why not; it does
 * not persist anything, does not know about the database, and does not import
 * from the UI. Business logic lives outside the interface, so both the server
 * and any screen can ask the same question and get the same answer.
 */

import {
  CASE_STAGE_PROGRESSION,
  type CaseStage,
  type LostReason,
  isTerminalStage,
  stageOrdinal,
} from "./stages.js";

/**
 * Who is permitted to make a transition.
 *
 * `system` transitions are automatic consequences of something else changing —
 * a submission being created, the last requirement being verified. They exist
 * so the two axes cannot drift apart (ADR-019), and the UI must show them as
 * system-driven so nobody wonders who moved their case.
 */
export type TransitionActor = "user" | "system";

/**
 * The facts a guard needs in order to judge a transition.
 *
 * Deliberately a flat snapshot of primitives rather than a live case object:
 * guards stay trivially testable, and the caller is forced to state explicitly
 * which facts it is asserting.
 */
export interface CaseSnapshot {
  readonly stage: CaseStage;
  /** Requirements that apply to this case and are not yet verified, waived or N/A. */
  readonly outstandingRequirementCount: number;
  /** Submissions that have actually gone to a bank (status beyond `not_submitted`). */
  readonly liveSubmissionCount: number;
  /** True when at least one sanctioned submission has an offer attached (BR-023). */
  readonly hasSanctionedSubmissionWithOffer: boolean;
  /** True when exactly one submission has reached `disbursed` (BR-022). */
  readonly hasDisbursedSubmission: boolean;
  /** Set once close-out is complete — invoice raised, commission settled. */
  readonly isInvoiceRaised: boolean;
  /** The stage a lost case was in when it was lost, used to restore on reopen. */
  readonly stageBeforeLost: CaseStage | null;
}

export interface TransitionRequest {
  readonly to: CaseStage;
  readonly actor: TransitionActor;
  /** Mandatory when moving to `lost` — a loss without a reason teaches nothing. */
  readonly lostReason?: LostReason;
}

export type TransitionOutcome =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

const ALLOWED: TransitionOutcome = { allowed: true };

function deny(reason: string): TransitionOutcome {
  return { allowed: false, reason };
}

/** A guard answers: given these facts, may this transition happen? */
type Guard = (snapshot: CaseSnapshot, request: TransitionRequest) => TransitionOutcome;

interface TransitionRule {
  readonly from: CaseStage;
  readonly to: CaseStage;
  readonly actor: TransitionActor;
  readonly guard?: Guard;
}

const requirementsSettled: Guard = (snapshot) =>
  snapshot.outstandingRequirementCount === 0
    ? ALLOWED
    : deny(
        `${snapshot.outstandingRequirementCount} requirement(s) still outstanding. ` +
          `Verify or waive them before the file is ready.`,
      );

const requirementsOutstanding: Guard = (snapshot) =>
  snapshot.outstandingRequirementCount > 0
    ? ALLOWED
    : deny("Nothing is outstanding, so the case is still ready for submission.");

const hasLiveSubmission: Guard = (snapshot) =>
  snapshot.liveSubmissionCount > 0
    ? ALLOWED
    : deny("No submission has been sent to a bank yet.");

const sanctionHasOffer: Guard = (snapshot) =>
  snapshot.hasSanctionedSubmissionWithOffer
    ? ALLOWED
    : deny("A sanction needs an offer attached before the case can advance (BR-023).");

const disbursementExists: Guard = (snapshot) =>
  snapshot.hasDisbursedSubmission
    ? ALLOWED
    : deny("No submission has been disbursed (BR-022).");

const invoiceRaised: Guard = (snapshot) =>
  snapshot.isInvoiceRaised
    ? ALLOWED
    : deny("Close-out is incomplete — the invoice has not been raised.");

/**
 * The transition table, mirroring PRD/Workflow.md one-for-one.
 *
 * Transitions to `lost` and out of `lost` are handled separately below, because
 * they apply to many stages and expressing them as rows would obscure the shape
 * of the normal path.
 */
const TRANSITION_RULES: readonly TransitionRule[] = [
  { from: "new", to: "contacted", actor: "user" },
  { from: "contacted", to: "appointment_fixed", actor: "user" },
  { from: "contacted", to: "documents_pending", actor: "user" },
  { from: "appointment_fixed", to: "documents_pending", actor: "user" },
  { from: "appointment_fixed", to: "contacted", actor: "user" },
  {
    from: "documents_pending",
    to: "ready_for_submission",
    actor: "system",
    guard: requirementsSettled,
  },
  // The backwards move that matters: a co-applicant added in week three, or a
  // bank asking for something nobody anticipated. Automatic and visible, never
  // silent — see PRD/Workflow.md and ADR-010.
  {
    from: "ready_for_submission",
    to: "documents_pending",
    actor: "system",
    guard: requirementsOutstanding,
  },
  {
    from: "ready_for_submission",
    to: "submitted",
    actor: "system",
    guard: hasLiveSubmission,
  },
  { from: "submitted", to: "sanctioned", actor: "system", guard: sanctionHasOffer },
  { from: "sanctioned", to: "disbursed", actor: "system", guard: disbursementExists },
  { from: "disbursed", to: "closed", actor: "user", guard: invoiceRaised },
];

/**
 * Decide whether a case may move as requested.
 *
 * Returns a reason on refusal rather than a bare boolean: the reason is shown to
 * the user, and a refusal a user cannot understand is a dead end.
 */
export function evaluateTransition(
  snapshot: CaseSnapshot,
  request: TransitionRequest,
): TransitionOutcome {
  if (snapshot.stage === request.to) {
    return deny(`The case is already at ${request.to}.`);
  }

  if (request.to === "lost") {
    return evaluateLoss(snapshot, request);
  }

  if (snapshot.stage === "lost") {
    return evaluateReopen(snapshot, request);
  }

  if (snapshot.stage === "closed") {
    return deny("A closed case cannot be moved. Closed is terminal.");
  }

  const rule = TRANSITION_RULES.find(
    (candidate) => candidate.from === snapshot.stage && candidate.to === request.to,
  );

  if (!rule) {
    return deny(`A case cannot move from ${snapshot.stage} to ${request.to}.`);
  }

  if (rule.actor !== request.actor) {
    return deny(
      `${snapshot.stage} → ${request.to} is a ${rule.actor} transition, ` +
        `but was requested by ${request.actor}.`,
    );
  }

  return rule.guard ? rule.guard(snapshot, request) : ALLOWED;
}

/**
 * Loss is reachable from any non-terminal stage, including `sanctioned` —
 * customers do walk away after sanction, usually over rate, and that is among
 * the most commercially useful things the company can record.
 */
function evaluateLoss(snapshot: CaseSnapshot, request: TransitionRequest): TransitionOutcome {
  if (isTerminalStage(snapshot.stage)) {
    return deny(`A ${snapshot.stage} case cannot be marked lost.`);
  }
  if (request.actor !== "user") {
    return deny("Only a person can mark a case lost. The system never gives up on a case.");
  }
  if (!request.lostReason) {
    return deny("A reason is required when marking a case lost.");
  }
  return ALLOWED;
}

/**
 * Reopening restores the stage the case was lost from. A postponed customer
 * returning six months later is common, and creating a fresh case would sever
 * the earlier conversation from the new one.
 */
function evaluateReopen(snapshot: CaseSnapshot, request: TransitionRequest): TransitionOutcome {
  if (request.actor !== "user") {
    return deny("Only a person can reopen a case.");
  }
  if (snapshot.stageBeforeLost === null) {
    return deny("The stage this case was lost from is unknown, so it cannot be restored.");
  }
  if (request.to !== snapshot.stageBeforeLost) {
    return deny(
      `A reopened case returns to ${snapshot.stageBeforeLost}, the stage it was lost from.`,
    );
  }
  return ALLOWED;
}

/**
 * The furthest stage the facts justify, ignoring where the case currently is.
 *
 * Ordered highest-first: a disbursed submission implies the case was sanctioned
 * and submitted, so the highest applicable stage is the answer, not the sum.
 */
function highestJustifiedStage(snapshot: CaseSnapshot): CaseStage | null {
  const candidates: readonly { stage: CaseStage; applies: boolean }[] = [
    { stage: "disbursed", applies: snapshot.hasDisbursedSubmission },
    { stage: "sanctioned", applies: snapshot.hasSanctionedSubmissionWithOffer },
    { stage: "submitted", applies: snapshot.liveSubmissionCount > 0 },
  ];

  return candidates.find((candidate) => candidate.applies)?.stage ?? null;
}

/**
 * Every stage a case must pass through to reach the stage its submissions
 * justify, in order — used to drive automatic advancement (ADR-019).
 *
 * Returns a *path*, not a destination, because each step is a separate
 * transition and each writes its own event. A case that goes from `submitted` to
 * `disbursed` was sanctioned on the way, and the timeline has to say so.
 *
 * One-directional by design: a rejection at one bank never moves a case
 * backwards, because other submissions may still be live.
 *
 * Every step is still evaluated against its guard. If one refuses — a sanction
 * with no offer attached yet — the path stops there rather than skipping it.
 */
export function deriveSystemStagePath(snapshot: CaseSnapshot): readonly CaseStage[] {
  const target = highestJustifiedStage(snapshot);
  if (target === null) {
    return [];
  }

  const currentOrdinal = stageOrdinal(snapshot.stage);
  const targetOrdinal = stageOrdinal(target);

  // A terminal case is never auto-advanced. A lost case with a live submission
  // stays lost until a human reopens it (ADR-023, and `Workflow.md` — only a
  // person reopens a case).
  if (currentOrdinal === null || targetOrdinal === null) {
    return [];
  }

  // Already at or beyond what the facts justify. `>` matters as much as `===`:
  // a rejection reduces the justified stage, and the case must not follow it
  // down.
  if (targetOrdinal <= currentOrdinal) {
    return [];
  }

  const path: CaseStage[] = [];
  let cursor = snapshot;

  for (let ordinal = currentOrdinal + 1; ordinal <= targetOrdinal; ordinal += 1) {
    const next = CASE_STAGE_PROGRESSION[ordinal];
    if (next === undefined) {
      break;
    }

    const outcome = evaluateTransition(cursor, { to: next, actor: "system" });
    if (!outcome.allowed) {
      break;
    }

    path.push(next);
    cursor = { ...cursor, stage: next };
  }

  return path;
}

/**
 * The next stage a case should move to, or `null` if it is where it belongs.
 *
 * The single step at the head of `deriveSystemStagePath`. Callers that apply one
 * transition at a time and re-derive get the same result; callers that want the
 * whole run in one transaction should use the path directly.
 */
export function deriveSystemStage(snapshot: CaseSnapshot): CaseStage | null {
  return deriveSystemStagePath(snapshot)[0] ?? null;
}
