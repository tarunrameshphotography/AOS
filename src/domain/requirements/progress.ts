/**
 * Case progress and document completeness.
 *
 * Source of truth: PRD/Requirements and Progress.md, ADR-011
 *
 * The rule this module exists to enforce: a case is measured only against what
 * that specific case genuinely requires. An absent optional participant can
 * never lower a score, because absent participants generate no requirements at
 * all — absence is silence (ADR-010).
 *
 * A salaried applicant with no co-applicant, no guarantor and no property yet
 * must be able to reach 100%. A progress bar that cannot fill on a simple case
 * is one users learn to ignore, and once ignored it is permanently useless.
 */

import { type CaseStage, type ProgressionStage, stageOrdinal } from "../case/stages.js";
import type { ApplicabilityCode } from "../products/catalogue.js";

export const REQUIREMENT_STATUSES = [
  "pending",
  "received",
  "verified",
  /**
   * A human looked at what was uploaded and refused it (BR-032). Distinct
   * from `pending`, which the workflow used to fall back to: "nothing has
   * arrived" and "something arrived and was wrong" are different facts, and
   * only one of them means somebody has already had their time wasted.
   * Counts as outstanding, exactly like pending.
   */
  "rejected",
  "waived",
  "not_applicable",
] as const;

export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** Statuses from which a fresh upload is the next move. */
export const OUTSTANDING_STATUSES: readonly RequirementStatus[] = ["pending", "rejected"];

/**
 * Statuses excluded from progress arithmetic entirely — they leave both the
 * numerator and the denominator (ADR-011, BR-034).
 */
const EXCLUDED_FROM_PROGRESS: readonly RequirementStatus[] = ["waived", "not_applicable"];

export interface Requirement {
  readonly id: string;
  readonly status: RequirementStatus;
  /**
   * The stage from which this requirement becomes due. A property valuation is
   * genuinely required for a home loan, but demanding it before a property has
   * been chosen makes the checklist wrong and the progress figure useless.
   */
  readonly applicableFromStage: ProgressionStage;
  /**
   * How strongly the rule that generated this row asks for it (ADR-035).
   * `optional` requirements are shown, collected and verified like any other,
   * but never counted against the case — an optional document that nobody
   * chased must not be able to hold a complete file at 94%.
   *
   * Undefined means mandatory, so rows generated before the rule engine
   * existed (and every test that does not care) behave exactly as before.
   */
  readonly applicability?: ApplicabilityCode | undefined;
}

export interface ProgressSummary {
  /** Requirements that count toward the score right now. */
  readonly applicableCount: number;
  readonly verifiedCount: number;
  /** Received but not yet checked by a human (BR-032). */
  readonly receivedCount: number;
  /** Uploaded, looked at, and refused. A subset of `outstandingCount`. */
  readonly rejectedCount: number;
  readonly outstandingCount: number;
  readonly waivedCount: number;
  readonly notApplicableCount: number;
  /** Due, wanted, and deliberately not counted against the case. */
  readonly optionalCount: number;
  /** Not yet due at the case's current stage. Shown as upcoming, never as missing. */
  readonly upcomingCount: number;
  /** 0–100, rounded. A case with nothing applicable is complete, not zero. */
  readonly percentComplete: number;
  /** True when nothing applicable is outstanding — drives the stage guard. */
  readonly isReadyForSubmission: boolean;
}

/**
 * Compute progress for a case.
 *
 * Takes a `CaseStage` rather than a raw index: ordinal arithmetic belongs to the
 * domain layer, not to every caller (ADR-023).
 *
 * @param requirements every requirement generated for the case
 * @param currentStage the case's stage, used to decide which requirements are
 *   due yet. Terminal stages have no ordinal position — a closed or lost case
 *   requires nothing further, and is reported as such.
 */
export function summariseProgress(
  requirements: readonly Requirement[],
  currentStage: CaseStage,
): ProgressSummary {
  const currentOrdinal = stageOrdinal(currentStage);

  // A terminal case is done with requirements, whatever their status. Reporting
  // outstanding documents on a lost case would be noise, and reporting them as
  // *due* would be wrong.
  const due =
    currentOrdinal === null
      ? []
      : requirements.filter((requirement) => {
          const requiredFrom = stageOrdinal(requirement.applicableFromStage);
          return requiredFrom !== null && requiredFrom <= currentOrdinal;
        });

  const upcomingCount = requirements.length - due.length;

  const waivedCount = due.filter((r) => r.status === "waived").length;
  const notApplicableCount = due.filter((r) => r.status === "not_applicable").length;
  const optionalCount = due.filter(
    (r) => r.applicability === "optional" && !EXCLUDED_FROM_PROGRESS.includes(r.status),
  ).length;

  const applicable = due.filter(
    (r) => !EXCLUDED_FROM_PROGRESS.includes(r.status) && r.applicability !== "optional",
  );

  const verifiedCount = applicable.filter((r) => r.status === "verified").length;
  const receivedCount = applicable.filter((r) => r.status === "received").length;
  const rejectedCount = applicable.filter((r) => r.status === "rejected").length;
  const outstandingCount = applicable.length - verifiedCount;

  // A case with nothing applicable is complete. This is the simple-case
  // guarantee: one applicant, no optional parties, and the bar fills.
  const percentComplete =
    applicable.length === 0 ? 100 : Math.round((verifiedCount / applicable.length) * 100);

  return {
    applicableCount: applicable.length,
    verifiedCount,
    receivedCount,
    rejectedCount,
    outstandingCount,
    waivedCount,
    notApplicableCount,
    optionalCount,
    upcomingCount,
    percentComplete,
    isReadyForSubmission: outstandingCount === 0,
  };
}
