/**
 * What a requirement's status is CALLED on a collection call.
 *
 * WHY THIS EXISTS
 *
 * The domain's six statuses (`pending`, `received`, `verified`, `rejected`,
 * `waived`, `not_applicable`) are the right names for the model and the wrong
 * names for a telecaller. Title-cased straight onto the screen they produced
 * two rows both reading "Pending" — one where the customer has sent nothing,
 * one where a file arrived and is sitting unchecked — and a "Received" that
 * reads like the job is done when it is exactly half done.
 *
 * So this module is a TRANSLATION, not a second status model. It adds no
 * state, stores nothing, and every function here is pure: give it a status and
 * how strongly the rule asked, and it tells you what to put on the row. The
 * statuses themselves, and every decision made from them, stay in
 * @domain/requirements/progress.ts.
 *
 * The distinction the milestone asks for (Part 8) is between a document that
 * is MISSING, one that has been UPLOADED and is awaiting a human, and one that
 * is VERIFIED — and separately, whether it was ever mandatory. Those are four
 * different sentences a telecaller says to a customer, and one word each.
 */

import type { ApplicabilityCode } from "@domain/products/index.js";
import type { ProgressSummary, RequirementStatus } from "@domain/requirements/index.js";

/**
 * The presentational states. More than the six statuses because `pending`
 * splits on whether the document is mandatory: "we are still waiting for your
 * payslip" and "we would take a payslip if you have one" are not the same
 * call.
 */
export const DOCUMENT_STATES = [
  "missing",
  "optional_missing",
  "awaiting_verification",
  "verified",
  "rejected",
  "waived",
  "not_applicable",
] as const;

export type DocumentState = (typeof DOCUMENT_STATES)[number];

export type DocumentStateTone = "good" | "info" | "warn" | "bad" | "neutral";

interface DocumentStatePresentation {
  /** The badge on the row. */
  readonly label: string;
  readonly tone: DocumentStateTone;
  /** What it means, in the words used to the customer. */
  readonly meaning: string;
}

export const DOCUMENT_STATE_PRESENTATION: Record<DocumentState, DocumentStatePresentation> = {
  missing: {
    label: "Not received",
    tone: "neutral",
    meaning: "Nothing has arrived against this yet. Still to collect.",
  },
  optional_missing: {
    label: "Optional — not received",
    tone: "neutral",
    meaning:
      "Wanted if it exists, never counted against the case. A file is not incomplete for missing one.",
  },
  awaiting_verification: {
    label: "Awaiting verification",
    tone: "info",
    meaning:
      "A file has been uploaded and nobody has looked at it. Uploading is not the same as done.",
  },
  verified: {
    label: "Verified",
    tone: "good",
    meaning: "A human opened it and confirmed it is the document that was asked for.",
  },
  rejected: {
    label: "Rejected — upload again",
    tone: "bad",
    meaning: "Somebody looked at what arrived and refused it. The reason is on the row.",
  },
  waived: {
    label: "Waived",
    tone: "warn",
    meaning: "Deliberately not collected, with a name and a reason against it. Not counted as done.",
  },
  not_applicable: {
    label: "No longer asked for",
    tone: "neutral",
    meaning: "Was on the list and is not now. Kept because asking for it is part of what happened.",
  },
};

/**
 * The state a row is in.
 *
 * `applicability` is undefined on rows generated before the rule engine, and
 * undefined reads as mandatory — the same reading progress.ts uses, so a row
 * can never be counted against a case while being labelled optional.
 */
export function documentStateOf(
  status: RequirementStatus,
  applicability?: ApplicabilityCode | undefined,
): DocumentState {
  switch (status) {
    case "pending":
      return applicability === "optional" ? "optional_missing" : "missing";
    case "received":
      return "awaiting_verification";
    case "verified":
      return "verified";
    case "rejected":
      return "rejected";
    case "waived":
      return "waived";
    case "not_applicable":
      return "not_applicable";
  }
}

export function documentStateLabel(
  status: RequirementStatus,
  applicability?: ApplicabilityCode | undefined,
): string {
  return DOCUMENT_STATE_PRESENTATION[documentStateOf(status, applicability)].label;
}

export function documentStateTone(
  status: RequirementStatus,
  applicability?: ApplicabilityCode | undefined,
): DocumentStateTone {
  return DOCUMENT_STATE_PRESENTATION[documentStateOf(status, applicability)].tone;
}

/**
 * The headline counts, derived from the progress summary the domain already
 * computes — never recounted here.
 *
 * That derivation is the point: a second count of the same requirements is a
 * second answer waiting to disagree with the progress bar, and a progress bar
 * that disagrees with the list beneath it is one nobody believes again. Every
 * figure below is arithmetic on ProgressSummary, so the strip and the bar
 * cannot drift apart.
 */
export interface DocumentStateCounts {
  /** Mandatory, due now, counting toward the score. */
  readonly required: number;
  /** Uploaded and not yet checked. */
  readonly awaitingVerification: number;
  /** Uploaded, checked, refused — needs a fresh upload. */
  readonly rejected: number;
  readonly verified: number;
  /** Mandatory and due, with nothing uploaded against it at all. */
  readonly missing: number;
  readonly optional: number;
  readonly waived: number;
  /** Real requirements that are not due at this stage yet. */
  readonly notDueYet: number;
}

export function documentStateCounts(progress: ProgressSummary): DocumentStateCounts {
  return {
    required: progress.applicableCount,
    awaitingVerification: progress.receivedCount,
    rejected: progress.rejectedCount,
    verified: progress.verifiedCount,
    // Outstanding is everything applicable that is not verified; take off the
    // rows that at least have a file against them and what is left has never
    // been sent.
    missing: progress.outstandingCount - progress.receivedCount - progress.rejectedCount,
    optional: progress.optionalCount,
    waived: progress.waivedCount,
    notDueYet: progress.upcomingCount,
  };
}

/**
 * Is this case's mandatory collection genuinely finished?
 *
 * Deliberately NOT "were any files uploaded" (Part 8). A case with every
 * document uploaded and none verified is not complete, and must never be shown
 * as such — a human has still to look at every one of them.
 */
export function isDocumentCollectionComplete(progress: ProgressSummary): boolean {
  return progress.outstandingCount === 0;
}
