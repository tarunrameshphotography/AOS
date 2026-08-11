/**
 * The one place a submission/offer outcome moves a case's stage — Phase 5.
 *
 * Before this file, three call sites (`documents.ts`'s `reconcileStage`,
 * `submissions.ts`'s `finalizeIfFullySent`, `cases.ts`'s `snapshotOf`) each
 * hand-rolled a single-step `evaluateTransition` call and hard-coded
 * `hasSanctionedSubmissionWithOffer`/`hasDisbursedSubmission` to `false`,
 * because nothing before Phase 5 could make either true. Phase 5 makes both
 * real, and a single-step call is no longer safe: a submission can jump
 * straight from `submitted` to `disbursed` (sanction and disbursement
 * recorded in the same visit), and a case sitting at `ready_for_submission`
 * must walk `submitted -> sanctioned -> disbursed` in one go, each step its
 * own audited `case.stage_changed` event, or it is left stranded at
 * `submitted` with facts that justify further. `deriveSystemStagePath`
 * (`@domain/case/transitions.js`) already computes that whole path and
 * refuses to skip a step whose guard fails — this module is only the
 * Postgres wiring: read the facts, walk the path, write one row and one
 * event per step.
 */

import { deriveSystemStagePath, type CaseSnapshot } from "@domain/case/transitions.js";
import type { CaseStage } from "@domain/case/stages.js";

import type { Queryable } from "./db.js";
import { recordSystemCaseEvent } from "./events.js";

export interface CauseRef {
  readonly entityType: string;
  readonly entityId: string;
}

/**
 * Serialise every Phase 5 outcome mutation on one case — status changes,
 * offer recording and acceptance, query raise/answer — the same
 * `pg_advisory_xact_lock` idiom Phase 3 established for sending
 * (`Backend/submissions.ts`'s `lockSubmissionForSending`), keyed on the
 * *case* rather than the submission because BR-025's cascade (accepting one
 * offer withdraws every other live submission on the case) touches sibling
 * rows: two employees accepting competing offers on the same case at once, or
 * one employee double-clicking Accept, must not both read the case's
 * facts before either has committed its outcome. A different salt (`1`) from
 * the submission-send lock's (`0`) — they guard unrelated concerns and must
 * not queue behind each other.
 */
export async function lockCaseForOutcomeMutation(client: Queryable, caseId: string): Promise<void> {
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 1))`, [caseId]);
}

export interface SubmissionOutcomeFacts {
  readonly liveSubmissionCount: number;
  readonly hasSanctionedSubmissionWithOffer: boolean;
  readonly hasDisbursedSubmission: boolean;
}

/**
 * The two facts nothing before Phase 5 could compute, plus the live-submission
 * count `Backend/cases.ts` and `Backend/submissions.ts` already counted
 * separately — now one query, so the three call sites cannot drift on what
 * "sanctioned with an offer" means.
 */
export async function submissionOutcomeFacts(
  client: Queryable,
  caseId: string,
): Promise<SubmissionOutcomeFacts> {
  const { rows } = await client.query<{
    live: string;
    sanctioned_with_offer: boolean | null;
    disbursed: boolean | null;
  }>(
    `select
       count(*) filter (where status <> 'not_submitted') as live,
       bool_or(
         status in ('sanctioned', 'disbursed')
         and exists (select 1 from offer o where o.submission_id = submission.id)
       ) as sanctioned_with_offer,
       bool_or(status = 'disbursed') as disbursed
     from submission
     where case_id = $1`,
    [caseId],
  );
  const row = rows[0];
  return {
    liveSubmissionCount: Number(row?.live ?? 0),
    hasSanctionedSubmissionWithOffer: row?.sanctioned_with_offer === true,
    hasDisbursedSubmission: row?.disbursed === true,
  };
}

/**
 * Advance a case through every stage its current facts justify, one
 * `case.stage_changed` event per step, then return the stage it ended at
 * (unchanged if nothing was justified, or if the case is on hold — a held
 * case does not advance out from under whoever put it on hold, matching the
 * early-return every existing caller already applied by hand).
 *
 * `outstandingRequirementCount` is passed in rather than computed here: the
 * two existing call sites already disagree, on purpose, about whether to
 * regenerate requirements first (`Backend/requirements.ts`'s
 * `outstandingRequirementCount` does; `documents.ts`'s `outstandingCountOnly`
 * deliberately does not, to avoid paying for a regeneration its caller just
 * ran). A submission/offer mutation touches no document, so it always wants
 * the cheap count.
 */
export async function advanceCaseStage(
  client: Queryable,
  caseId: string,
  outstandingRequirementCount: number,
  causedBy: CauseRef,
): Promise<CaseStage> {
  const { rows } = await client.query<{
    stage: CaseStage;
    is_on_hold: boolean;
    is_invoice_raised: boolean;
    stage_before_lost: CaseStage | null;
  }>(
    `select stage, is_on_hold, is_invoice_raised, stage_before_lost from loan_case where id = $1`,
    [caseId],
  );
  const row = rows[0];
  if (!row || row.is_on_hold) return row?.stage ?? "new";

  const facts = await submissionOutcomeFacts(client, caseId);
  const snapshot: CaseSnapshot = {
    stage: row.stage,
    outstandingRequirementCount,
    liveSubmissionCount: facts.liveSubmissionCount,
    hasSanctionedSubmissionWithOffer: facts.hasSanctionedSubmissionWithOffer,
    hasDisbursedSubmission: facts.hasDisbursedSubmission,
    isInvoiceRaised: row.is_invoice_raised,
    stageBeforeLost: row.stage_before_lost,
  };

  const path = deriveSystemStagePath(snapshot);
  let stage = row.stage;
  for (const next of path) {
    await client.query(`update loan_case set stage = $1 where id = $2`, [next, caseId]);
    await recordSystemCaseEvent(client, {
      caseId,
      eventType: "case.stage_changed",
      payloadBefore: { stage },
      payloadAfter: { stage: next },
      causedByEntityType: causedBy.entityType,
      causedByEntityId: causedBy.entityId,
    });
    stage = next;
  }
  return stage;
}
