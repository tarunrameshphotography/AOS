/**
 * Cases — the `loan_case` table — server-side.
 *
 * Moved out of `api-server.ts` in Stage 3B and widened, for the same reason
 * `customers.ts` was: Stage 2 carried ten fields where the case screen renders
 * about twenty, and a migration that silently drops the hold reason, the lost
 * reason and who brought the case in is not a migration.
 *
 * IT ALSO GAINS THE OPERATIONS, not just the fields. A case screen is mostly
 * verbs — move the stage, put it on hold, mark it lost, hand it to someone
 * else — and every one of them was a `store.ts` function whose permission
 * check ran in the browser. They are here now, which is the entire point of
 * the exercise.
 *
 * THE STAGE MACHINE IS NOT REIMPLEMENTED. `evaluateTransition` from
 * `@domain/case/transitions` decides whether a move is legal, exactly as it
 * does for the prototype store, and its refusal text is what the employee
 * sees. A second copy of the workflow written "for the backend" is precisely
 * the drift ADR-022 forbids for permissions and the same argument applies
 * here.
 *
 * STILL NOT HERE, by the scope of Stage 3B: documents, requirements,
 * verification, submissions, offers, notes, communications, the timeline.
 * Case parties beyond the primary applicant, and case properties, go with
 * them — they exist to feed the requirement engine, which has not moved.
 */

import { CASE_STAGES, LOST_REASONS, type CaseStage, type LostReason } from "@domain/case/stages.js";
import { evaluateTransition, type CaseSnapshot } from "@domain/case/transitions.js";

import type { Queryable } from "./db.js";
import { can, canActOnCase, widestScopeFor, type Actor } from "./authorize.js";
import { recordCaseEvent } from "./events.js";
import { ApiError, refusalMessage } from "./http.js";
import { caseListProgress, outstandingRequirementCount } from "./requirements.js";

const COLUMNS = `c.id, c.case_number, c.loan_product_id, c.requested_amount, c.stage,
                 c.owner_user_id, c.created_by, c.source, c.referral_source_id,
                 c.is_on_hold, c.hold_reason, c.hold_until,
                 c.lost_reason, c.lost_note, c.lost_at, c.stage_before_lost,
                 c.is_invoice_raised, c.closed_at, c.created_at, c.updated_at`;

/**
 * The primary applicant travels with every case row.
 *
 * Not a convenience: a case list with no applicant name is unreadable, and
 * BR-010 guarantees exactly one primary party at all times, so this is a
 * property of the case rather than a join the caller might forget.
 */
const APPLICANT_JOIN = `
  left join case_party pa
         on pa.case_id = c.id and pa.is_primary and pa.removed_at is null
  left join person ap on ap.id = pa.person_id`;

const APPLICANT_COLUMNS = `pa.person_id as applicant_id, ap.full_name as applicant_name,
  (select i.value_raw from person_identifier i
    where i.person_id = pa.person_id and i.identifier_type = 'phone' and i.is_primary
      and (i.valid_to is null or i.valid_to > current_date)
    limit 1) as applicant_phone`;

export function caseFromRow(
  row: Record<string, unknown>,
  progress?: { percentComplete: number; applicableCount: number },
) {
  return {
    id: row.id,
    caseNumber: row.case_number,
    loanProductId: row.loan_product_id,
    requestedAmount: row.requested_amount === null ? null : Number(row.requested_amount),
    stage: row.stage,
    ownerUserId: row.owner_user_id,
    createdByUserId: row.created_by,
    source: row.source,
    referralSourceId: row.referral_source_id,
    isOnHold: row.is_on_hold,
    holdReason: row.hold_reason,
    holdUntil: row.hold_until,
    lostReason: row.lost_reason,
    lostNote: row.lost_note,
    lostAt: row.lost_at,
    stageBeforeLost: row.stage_before_lost,
    isInvoiceRaised: row.is_invoice_raised,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    applicantId: row.applicant_id ?? null,
    applicantName: row.applicant_name ?? null,
    applicantPhone: row.applicant_phone ?? null,
    ...(progress ? { progress } : {}),
  };
}

/**
 * The facts the transition machine judges against, from a case row.
 *
 * `outstandingRequirementCount` IS REAL, as of Stage 3C — `Backend/requirements.ts`
 * regenerates the case's requirements from the rule engine and counts what is
 * not yet verified, waived or not_applicable. The guard on
 * `documents_pending → ready_for_submission` (and its reverse) now runs
 * against genuine data, since `evaluateTransition` is never bypassed:
 * whatever this function reports is exactly what the domain layer judges.
 *
 * `liveSubmissionCount` is real as of Stage 3D — `Backend/submissions.ts`
 * writes genuine `submission` rows now, so this counts them rather than
 * assuming zero. `hasSanctionedSubmissionWithOffer` and
 * `hasDisbursedSubmission` remain false — sanction and disbursement are still
 * out of scope (Stage 3D built the submission vertical only). Every
 * transition whose guard reads those two — → sanctioned, → disbursed — is
 * declared `actor: "system"`, and `evaluateTransition` checks the actor
 * BEFORE running the guard, so a request from this API is refused on the
 * actor check and the `false`s are never consulted. → submitted is the same
 * shape but its guard (`hasLiveSubmission`) now reads a genuine count: this
 * function existing to serve `moveStage`, a `user`-actor endpoint, means the
 * actor check still refuses it first, exactly as before — the fact only
 * matters to `Backend/submissions.ts`'s own system-actor evaluation after a
 * send succeeds.
 *
 * The one guarded USER transition, disbursed → closed, reads `isInvoiceRaised`
 * — a column on `loan_case`, which the server does know and passes honestly.
 */
async function snapshotOf(client: Queryable, row: Record<string, unknown>): Promise<CaseSnapshot> {
  return {
    stage: row.stage as CaseStage,
    outstandingRequirementCount: await outstandingRequirementCount(client, row.id as string),
    liveSubmissionCount: await liveSubmissionCount(client, row.id as string),
    hasSanctionedSubmissionWithOffer: false,
    hasDisbursedSubmission: false,
    isInvoiceRaised: row.is_invoice_raised === true,
    stageBeforeLost: (row.stage_before_lost as CaseStage | null) ?? null,
  };
}

/** Submissions that have actually gone to a bank — status beyond
 * `not_submitted` — matching `CaseSnapshot.liveSubmissionCount`'s own
 * definition (`src/domain/case/transitions.ts`). */
async function liveSubmissionCount(client: Queryable, caseId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `select count(*) as n from submission where case_id = $1 and status <> 'not_submitted'`,
    [caseId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** 404 rather than 403 when the actor may not see a case. 403 would confirm it
 * exists, which is itself information: a Telecaller probing `/api/cases/<uuid>`
 * could map colleagues' caseload without reading a single field. */
function notFound(): ApiError {
  return new ApiError(404, "No such case, or you do not have access to it.");
}

/** Read the case for a write, having already established the actor may see it
 * AND act on it. Read access decides whether the case is acknowledged at all;
 * write access is checked separately, so someone who may see a case but not
 * edit it gets a 403 naming the permission rather than a misleading 404. */
async function loadForWrite(
  client: Queryable,
  actor: Actor,
  id: string,
  permission: string,
): Promise<Record<string, unknown>> {
  const { rows } = await client.query(
    `select ${COLUMNS} from loan_case c where c.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  if (!canActOnCase(actor, row.owner_user_id, "case.read")) throw notFound();
  if (!canActOnCase(actor, row.owner_user_id, permission)) {
    throw new ApiError(403, refusalMessage(permission));
  }
  return row;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The scope rule, as a SQL filter.
 *
 * A Telecaller holds `case.read` at `own`, a Login Executive and above at
 * `all`. Without the `own` branch one Telecaller would list another's cases,
 * which is the precise thing this whole migration has to prove cannot happen.
 */
export async function listCases(client: Queryable, actor: Actor) {
  const scope = widestScopeFor(actor, "case.read");
  if (scope === null) throw new ApiError(403, refusalMessage("case.read"));

  const ownOnly = scope === "own";
  const { rows } = await client.query(
    `select ${COLUMNS}, ${APPLICANT_COLUMNS}
       from loan_case c ${APPLICANT_JOIN}
      ${ownOnly ? "where c.owner_user_id = $1" : ""}
      order by c.created_at desc limit 500`,
    ownOnly ? [actor.userId] : [],
  );

  // Real, Postgres-backed progress (Stage 3C) — restores the indicator the
  // audit found removed from this screen, replacing a number computed from
  // the prototype's local store, which the audit correctly refused to trust.
  const progressByCase = await caseListProgress(
    client,
    rows.map((row: Record<string, unknown>) => ({ id: row.id as string, stage: row.stage as CaseStage })),
  );

  return rows.map((row: Record<string, unknown>) => {
    const progress = progressByCase.get(row.id as string);
    return caseFromRow(
      row,
      progress ? { percentComplete: progress.percentComplete, applicableCount: progress.applicableCount } : undefined,
    );
  });
}

export async function readCase(client: Queryable, actor: Actor, id: string) {
  if (widestScopeFor(actor, "case.read") === null) {
    throw new ApiError(403, refusalMessage("case.read"));
  }

  const { rows } = await client.query(
    `select ${COLUMNS}, ${APPLICANT_COLUMNS} from loan_case c ${APPLICANT_JOIN} where c.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  if (!canActOnCase(actor, row.owner_user_id, "case.read")) throw notFound();
  return caseFromRow(row);
}

/** Every case a person is a party on, in any role — what makes recognition
 * possible ("3 previous cases, KYC on file"). Scoped exactly as the list is. */
export async function casesForPerson(client: Queryable, actor: Actor, personId: string) {
  const scope = widestScopeFor(actor, "case.read");
  if (scope === null) throw new ApiError(403, refusalMessage("case.read"));

  const ownOnly = scope === "own";
  const { rows } = await client.query(
    `select ${COLUMNS}, ${APPLICANT_COLUMNS}, party.role as party_role
       from loan_case c ${APPLICANT_JOIN}
       join case_party party
         on party.case_id = c.id and party.person_id = $1 and party.removed_at is null
      ${ownOnly ? "where c.owner_user_id = $2" : ""}
      order by c.created_at desc`,
    ownOnly ? [personId, actor.userId] : [personId],
  );
  return rows.map((row: Record<string, unknown>) => ({
    ...caseFromRow(row),
    partyRole: row.party_role,
  }));
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export async function createCase(client: Queryable, actor: Actor, body: Record<string, unknown>) {
  if (!can(actor, "case.create", "all")) {
    throw new ApiError(403, refusalMessage("case.create"));
  }

  const applicantId = typeof body.applicantId === "string" ? body.applicantId : null;
  const loanProductId = typeof body.loanProductId === "string" ? body.loanProductId : null;
  if (!applicantId) throw new ApiError(400, "A case needs an applicant.");
  if (!loanProductId) throw new ApiError(400, "A case needs a loan product.");

  const applicant = await client.query(`select id from person where id = $1`, [applicantId]);
  if (!applicant.rows[0]) throw new ApiError(400, "No such customer.");

  const product = await client.query(`select id from loan_product where id = $1`, [loanProductId]);
  if (!product.rows[0]) throw new ApiError(400, "No such loan product.");

  const referralSourceId =
    typeof body.referralSourceId === "string" && body.referralSourceId.length > 0
      ? body.referralSourceId
      : null;
  if (referralSourceId !== null) {
    const source = await client.query(`select id from referral_source where id = $1`, [
      referralSourceId,
    ]);
    if (!source.rows[0]) throw new ApiError(400, "No such referral source.");
  }

  // ADR-024: the number comes from the sequence function, never from the
  // application. Two PCs creating a case at the same moment is exactly the
  // case the row lock in there exists for.
  const numbered = await client.query<{ case_number: string }>(
    `select app.allocate_case_number() as case_number`,
  );

  // A case is owned by whoever created it. Reassignment is `case.assign`.
  const inserted = await client.query(
    `insert into loan_case (case_number, loan_product_id, requested_amount, stage,
                            owner_user_id, source, referral_source_id, created_by)
     values ($1, $2, $3, 'new', $4, $5, $6, $4)
     returning id`,
    [
      numbered.rows[0]!.case_number,
      loanProductId,
      body.requestedAmount ?? null,
      actor.userId,
      typeof body.source === "string" ? body.source : null,
      referralSourceId,
    ],
  );
  const caseId = inserted.rows[0]!.id;

  await client.query(
    `insert into case_party (case_id, person_id, role, is_primary, created_by)
     values ($1, $2, 'applicant', true, $3)`,
    [caseId, applicantId, actor.userId],
  );

  // IDs and case facts only. The applicant is referenced, never named.
  await recordCaseEvent(client, {
    actorUserId: actor.userId,
    caseId,
    eventType: "case.created",
    payloadAfter: {
      stage: "new",
      loanProductId,
      requestedAmount: body.requestedAmount ?? null,
      referralSourceId,
      ownerUserId: actor.userId,
      applicantId,
    },
  });

  return await readCase(client, actor, caseId);
}

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

const WRITABLE: Record<string, string> = {
  requestedAmount: "requested_amount",
  source: "source",
  referralSourceId: "referral_source_id",
};

/**
 * The plain field edits. Stage, hold and lost are NOT here: each has its own
 * permission and its own rules, and folding them into a generic field patch
 * would mean `case.update` silently granting `case.hold` and `case.mark_lost`.
 */
export async function updateCase(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const current = await loadForWrite(client, actor, id, "case.update");

  const submitted = Object.entries(WRITABLE).filter(([field]) => body[field] !== undefined);
  if (submitted.length === 0) throw new ApiError(400, "Nothing to update.");

  // Only genuinely changed fields are written, and an edit that changes
  // nothing appends nothing. The case screen submits the whole form on Save,
  // so without this a double-click — or a request the browser retried after a
  // dropped connection — would record a second edit nobody made.
  const sets: string[] = [];
  const values: unknown[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [field, column] of submitted) {
    const wanted = body[field] === "" ? null : body[field];
    if (sameValue(current[column], wanted)) continue;
    values.push(wanted);
    sets.push(`${column} = $${values.length}`);
    before[field] = current[column] ?? null;
    after[field] = wanted ?? null;
  }

  if (sets.length === 0) return await readCase(client, actor, id);

  values.push(id);
  await client.query(`update loan_case set ${sets.join(", ")} where id = $${values.length}`, values);

  await recordCaseEvent(client, {
    actorUserId: actor.userId,
    caseId: id,
    eventType: "case.facts_updated",
    payloadBefore: before,
    payloadAfter: after,
  });

  return await readCase(client, actor, id);
}

/**
 * Whether a stored column and a submitted value are the same fact.
 *
 * Text comparison, because `requested_amount` is `numeric` and the driver
 * returns it as the string `"3500000.00"` while the form submits the number
 * `3500000`. `===` on those is false forever, which would make every save look
 * like a change. `null` and `undefined` are one case: both mean "not set".
 */
function sameValue(stored: unknown, submitted: unknown): boolean {
  if (stored == null && submitted == null) return true;
  if (stored == null || submitted == null) return false;
  const numeric = Number(stored);
  if (!Number.isNaN(numeric) && typeof submitted === "number") return numeric === submitted;
  return String(stored) === String(submitted);
}

/**
 * Move a case to another stage.
 *
 * The domain layer decides. `evaluateTransition` knows which moves are legal,
 * which are backwards, and what to say when one is refused — "4 requirements
 * still outstanding" rather than a disabled button. The server repeats none of
 * that reasoning; it asks, and passes the refusal through verbatim.
 *
 * `lost` is deliberately not reachable here. Marking a case lost carries a
 * reason and a different permission, and letting it through as an ordinary
 * stage move would be a way around both.
 */
export async function moveStage(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const current = await loadForWrite(client, actor, id, "case.update");
  const to = String(body.stage ?? "") as CaseStage;

  if (!(CASE_STAGES as readonly string[]).includes(to)) {
    throw new ApiError(400, `Unknown stage: ${to}.`);
  }
  if (to === "lost") {
    throw new ApiError(400, "Marking a case lost needs a reason — use the lost action.");
  }
  if (current.is_on_hold) {
    throw new ApiError(409, "This case is on hold. Release the hold before moving it on.");
  }

  const verdict = evaluateTransition(await snapshotOf(client, current), { to, actor: "user" });
  if (!verdict.allowed) throw new ApiError(409, verdict.reason);

  await client.query(`update loan_case set stage = $1 where id = $2`, [to, id]);

  await recordCaseEvent(client, {
    actorUserId: actor.userId,
    caseId: id,
    eventType: "case.stage_changed",
    payloadBefore: { stage: current.stage },
    payloadAfter: { stage: to },
  });

  return await readCase(client, actor, id);
}

/** Put a case on hold, or release it. `case.hold` — a separate permission,
 * held at `own` by a Telecaller and at `all` above them. */
export async function setHold(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const current = await loadForWrite(client, actor, id, "case.hold");

  if (typeof body.isOnHold !== "boolean") {
    throw new ApiError(400, "isOnHold must be true or false.");
  }
  const reason = typeof body.holdReason === "string" ? body.holdReason.trim() : "";
  if (body.isOnHold && reason.length === 0) {
    // A hold with no reason is indistinguishable from a forgotten case.
    throw new ApiError(400, "A hold needs a reason.");
  }

  const holdUntil =
    body.isOnHold && typeof body.holdUntil === "string" && body.holdUntil.length > 0
      ? body.holdUntil
      : null;

  // Releasing a case that is not on hold changes nothing, and neither does
  // re-placing an identical hold. Both are things a retried request does.
  const unchanged =
    current.is_on_hold === body.isOnHold &&
    (body.isOnHold
      ? current.hold_reason === reason && sameValue(current.hold_until, holdUntil)
      : true);
  if (unchanged) return await readCase(client, actor, id);

  await client.query(
    `update loan_case set is_on_hold = $1, hold_reason = $2, hold_until = $3 where id = $4`,
    [body.isOnHold, body.isOnHold ? reason : null, holdUntil, id],
  );

  // `holdReason` is free text and stays out of the payload — see the payload
  // rules on `recordCaseEvent`. Whether there is a hold, and until when, are
  // facts about the case; what an employee typed about the customer's brother
  // is not.
  await recordCaseEvent(client, {
    actorUserId: actor.userId,
    caseId: id,
    eventType: body.isOnHold ? "case.held" : "case.hold_lifted",
    payloadBefore: { isOnHold: current.is_on_hold },
    payloadAfter: { isOnHold: body.isOnHold, holdUntil },
  });

  return await readCase(client, actor, id);
}

/**
 * Mark a case lost, with a reason.
 *
 * `stage_before_lost` is recorded so a reopen knows where to put it back. The
 * reason is a code from the domain's closed list rather than free text: "why
 * do we lose cases" is a question the business has to be able to answer by
 * counting, and free text cannot be counted.
 */
export async function markLost(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const current = await loadForWrite(client, actor, id, "case.mark_lost");
  const reason = String(body.lostReason ?? "") as LostReason;

  if (!(LOST_REASONS as readonly string[]).includes(reason)) {
    throw new ApiError(400, "A lost case needs one of the recorded reasons.");
  }

  // Whether a case may be lost from where it stands is the domain's question,
  // not this module's — `evaluateLoss` already knows that loss is reachable
  // from every non-terminal stage including `sanctioned`, and says why when
  // it is not.
  const verdict = evaluateTransition(await snapshotOf(client, current), {
    to: "lost",
    actor: "user",
    lostReason: reason,
  });
  if (!verdict.allowed) throw new ApiError(409, verdict.reason);

  await client.query(
    `update loan_case
        set stage = 'lost', stage_before_lost = $1, lost_reason = $2,
            lost_note = $3, lost_at = now()
      where id = $4`,
    [current.stage, reason, typeof body.lostNote === "string" ? body.lostNote.trim() : null, id],
  );

  // The reason CODE travels; `lostNote` does not. The code is a closed list
  // the business counts by; the note is free text about a named human.
  await recordCaseEvent(client, {
    actorUserId: actor.userId,
    caseId: id,
    eventType: "case.marked_lost",
    payloadBefore: { stage: current.stage },
    payloadAfter: { stage: "lost", lostReason: reason },
  });

  return await readCase(client, actor, id);
}

/** Reopen a lost case, back to where it was when it was lost. */
export async function reopen(client: Queryable, actor: Actor, id: string) {
  const current = await loadForWrite(client, actor, id, "case.reopen");
  if (current.stage !== "lost") throw new ApiError(409, "This case is not lost.");

  // Where a reopened case lands is the domain's decision — the stage it was
  // lost from, and a refusal if that is unknown.
  const restoreTo = (current.stage_before_lost as CaseStage | null) ?? "new";
  const verdict = evaluateTransition(await snapshotOf(client, current), { to: restoreTo, actor: "user" });
  if (!verdict.allowed) throw new ApiError(409, verdict.reason);

  await client.query(
    `update loan_case
        set stage = coalesce(stage_before_lost, 'new'), stage_before_lost = null,
            lost_reason = null, lost_note = null, lost_at = null
      where id = $1`,
    [id],
  );

  await recordCaseEvent(client, {
    actorUserId: actor.userId,
    caseId: id,
    eventType: "case.reopened",
    payloadBefore: { stage: "lost", stageBeforeLost: current.stage_before_lost ?? null },
    payloadAfter: { stage: restoreTo },
  });

  return await readCase(client, actor, id);
}

/** Hand a case to someone else. `case.assign` is held at `all` by Manager and
 * above only — a Telecaller cannot move their own case off their desk. */
export async function assignOwner(
  client: Queryable,
  actor: Actor,
  id: string,
  body: Record<string, unknown>,
) {
  const current = await loadForWrite(client, actor, id, "case.assign");

  const ownerUserId = typeof body.ownerUserId === "string" ? body.ownerUserId : "";
  const { rows } = await client.query(
    `select id from app_user where id = $1 and is_active`,
    [ownerUserId],
  );
  // Assigning a case to a deactivated account is how a case becomes nobody's.
  if (!rows[0]) throw new ApiError(400, "No such active employee.");

  // Reassigning to the current owner is a no-op, and a retried request must
  // not read as a second handover.
  if (current.owner_user_id === ownerUserId) return await readCase(client, actor, id);

  await client.query(`update loan_case set owner_user_id = $1 where id = $2`, [ownerUserId, id]);

  await recordCaseEvent(client, {
    actorUserId: actor.userId,
    caseId: id,
    eventType: "case.assigned",
    payloadBefore: { ownerUserId: current.owner_user_id },
    payloadAfter: { ownerUserId },
  });

  return await readCase(client, actor, id);
}
