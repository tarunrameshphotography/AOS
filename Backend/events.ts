/**
 * Appending to the audit log, server-side.
 *
 * BR-050: a state change and its event are written IN THE SAME TRANSACTION or
 * the change does not happen. Every request already runs inside one
 * transaction (`withActor` in db.ts), so a handler that calls this and then
 * throws leaves neither the change nor the event — which is the point.
 *
 * WHY THIS ARRIVES WITH USER MANAGEMENT: Stage 2 wrote no events at all, and
 * said so — the event log was outside its slice. It cannot stay outside this
 * one. "Who granted this person access to that?" is the question an
 * administrative surface exists to be able to answer, and an override that
 * appears with no record of who decided it is worse than no override feature.
 *
 * NO PERSONAL DATA IN PAYLOADS. The `event` table's own comment prohibits it:
 * the log is never redacted (BR-051), so a name copied into a payload is a
 * name that cannot later be erased, defeating ADR-018. Payloads here carry
 * IDs, permission keys, scopes and role names — never a person's name, phone
 * number or identifier. The frontend store's `summary` strings did embed
 * names; that is a prototype habit this deliberately does not port.
 *
 * WHY CUSTOMER AND CASE EVENTS ARRIVE NOW (Stage 3C-0): Stage 2 wrote no
 * events and said so; Stage 3B migrated the customer/case slice and carried
 * the debt forward. It cannot be carried further. Documents, verification and
 * bank submission — the next stage — all hang their history off the case
 * timeline, and a timeline that starts halfway through the life of a case is
 * worse than no timeline, because it reads as if nothing happened before it.
 *
 * EVENT NAMES ARE THE PROTOTYPE'S, NOT NEW ONES. `case.stage_changed`,
 * `case.marked_lost`, `case.held`, `person.identifier_updated` and the rest
 * are exactly the strings `Frontend/src/fake/store.ts` has been recording
 * since the prototype. Renaming them here would mean the migrated backend and
 * the not-yet-migrated screens describing the same fact two different ways,
 * and every later report having to know both.
 */

import type { Queryable } from "./db.js";

/** Event types this module emits, enumerated so a typo is a compile error
 * rather than an event nobody can search for later. */
export type UserEventType =
  | "user.created"
  | "user.roles_changed"
  | "user.activated"
  | "user.deactivated"
  | "user.password_reset"
  | "user.password_changed"
  | "user.permission_granted"
  | "user.permission_denied"
  | "user.permission_override_revoked";

export interface UserEvent {
  readonly actorUserId: string;
  readonly subjectUserId: string;
  readonly eventType: UserEventType;
  readonly payloadBefore?: Record<string, unknown> | null;
  readonly payloadAfter?: Record<string, unknown> | null;
}

/**
 * Record one administrative action against a user account.
 *
 * `actor_kind` is always `'user'` here: every action this module logs was
 * taken by a signed-in employee, and the schema's `event_actor_is_named`
 * check refuses a user event with no user. `source` is `'ui'` — these arrive
 * through the API on someone's behalf, not from automation or an import.
 */
export async function recordUserEvent(client: Queryable, event: UserEvent): Promise<void> {
  await client.query(
    `insert into event (actor_kind, actor_user_id, entity_type, entity_id,
                        event_type, payload_before, payload_after, source)
     values ('user', $1, 'app_user', $2, $3, $4, $5, 'ui')`,
    [
      event.actorUserId,
      event.subjectUserId,
      event.eventType,
      // `== null` deliberately, catching both undefined and null: JSON.stringify(null)
      // is the string "null", which Postgres stores as a jsonb null VALUE rather
      // than a SQL NULL, and the two read differently to anyone querying the log.
      event.payloadBefore == null ? null : JSON.stringify(event.payloadBefore),
      event.payloadAfter == null ? null : JSON.stringify(event.payloadAfter),
    ],
  );
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * Event types for the `person` table, as the prototype store names them.
 *
 * `person.updated` and `person.identifier_updated` are separate because they
 * answer different questions: "who corrected the spelling of this name" and
 * "who changed the number we have been calling" are not the same audit
 * question, and the second one is the one that matters when a call went to the
 * wrong person.
 */
export type CustomerEventType = "person.created" | "person.updated" | "person.identifier_updated";

export interface CustomerEvent {
  readonly actorUserId: string;
  readonly personId: string;
  readonly eventType: CustomerEventType;
  readonly payloadBefore?: Record<string, unknown> | null;
  readonly payloadAfter?: Record<string, unknown> | null;
}

/**
 * Record one change to a customer record.
 *
 * `case_id` is deliberately left null: a person is not owned by a case (ADR-006
 * — one person table, visible from every case they appear on), and pinning
 * their name correction to whichever case happened to be open would make their
 * profile history depend on where the edit was made from.
 *
 * CALLERS MUST NOT PUT VALUES IN THE PAYLOAD. Every field on `person` is
 * personal data — name, date of birth, address, identifiers — so what goes in
 * is the LIST OF FIELDS that changed, never what they changed from or to. The
 * current values live in `person`, the previous ones are gone by design
 * (ADR-018), and the audit question this log has to answer is "who touched
 * this, and when".
 */
export async function recordCustomerEvent(
  client: Queryable,
  event: CustomerEvent,
): Promise<void> {
  await client.query(
    `insert into event (actor_kind, actor_user_id, entity_type, entity_id,
                        event_type, payload_before, payload_after, source)
     values ('user', $1, 'person', $2, $3, $4, $5, 'ui')`,
    [
      event.actorUserId,
      event.personId,
      event.eventType,
      event.payloadBefore == null ? null : JSON.stringify(event.payloadBefore),
      event.payloadAfter == null ? null : JSON.stringify(event.payloadAfter),
    ],
  );
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/**
 * Event types for `loan_case`, as the prototype store names them.
 *
 * `case.marked_lost` rather than `case.lost`, and `case.held`/`case.hold_lifted`
 * rather than one `case.hold` carrying a boolean, because that is what
 * `Frontend/src/fake/store.ts` has recorded from the beginning and a timeline
 * reader should not have to know which half of the system wrote a row.
 *
 * `case.reopened` is the one name with no prototype precedent — the prototype
 * had no reopen — and follows the same shape.
 */
export type CaseEventType =
  | "case.created"
  | "case.facts_updated"
  | "case.stage_changed"
  | "case.assigned"
  | "case.held"
  | "case.hold_lifted"
  | "case.marked_lost"
  | "case.reopened";

export interface CaseEvent {
  readonly actorUserId: string;
  readonly caseId: string;
  readonly eventType: CaseEventType;
  readonly payloadBefore?: Record<string, unknown> | null;
  readonly payloadAfter?: Record<string, unknown> | null;
}

/**
 * Record one change to a case.
 *
 * `entity_type` is `'case'` and not `'loan_case'`: the prototype's events say
 * `case`, every timeline reader written so far matches on `case`, and the
 * table name is an implementation detail the log has never exposed. `case_id`
 * is set as well as `entity_id`, which is what `event_case_idx` and therefore
 * the whole case timeline is built on.
 *
 * WHAT CALLERS MAY PUT IN THE PAYLOAD: case facts — stage, amount, product id,
 * owner id, lost reason code. WHAT THEY MAY NOT: the free-text `hold_reason`
 * and `lost_note`. Those are boxes an employee types a sentence into, and the
 * sentence is routinely "customer's brother says wait until his salary lands".
 * That is personal data about a named human in a log that is never redacted.
 * The text stays on `loan_case`, where erasure can reach it.
 */
export async function recordCaseEvent(client: Queryable, event: CaseEvent): Promise<void> {
  await client.query(
    `insert into event (actor_kind, actor_user_id, entity_type, entity_id, case_id,
                        event_type, payload_before, payload_after, source)
     values ('user', $1, 'case', $2, $2, $3, $4, $5, 'ui')`,
    [
      event.actorUserId,
      event.caseId,
      event.eventType,
      event.payloadBefore == null ? null : JSON.stringify(event.payloadBefore),
      event.payloadAfter == null ? null : JSON.stringify(event.payloadAfter),
    ],
  );
}

/**
 * A case moving because of what the requirement/submission facts now say,
 * not because an employee clicked a stage — `documents_pending` to
 * `ready_for_submission` once nothing is outstanding, and the reverse
 * (ADR-019). `actor_user_id` is null, which `event_actor_is_named` only
 * permits for `actor_kind = 'system'` — the schema itself refuses a system
 * event that names a person.
 *
 * `causedByEntityType` / `causedByEntityId` cite the requirement or document
 * whose change triggered the move, so the case timeline can answer "why did
 * this happen" rather than leaving a stage change that nobody clicked.
 */
export async function recordSystemCaseEvent(
  client: Queryable,
  event: {
    readonly caseId: string;
    readonly eventType: CaseEventType;
    readonly payloadBefore?: Record<string, unknown> | null;
    readonly payloadAfter?: Record<string, unknown> | null;
    readonly causedByEntityType?: string;
    readonly causedByEntityId?: string;
  },
): Promise<void> {
  await client.query(
    `insert into event (actor_kind, actor_user_id, entity_type, entity_id, case_id,
                        event_type, payload_before, payload_after, source,
                        caused_by_entity_type, caused_by_entity_id)
     values ('system', null, 'case', $1, $1, $2, $3, $4, 'ui', $5, $6)`,
    [
      event.caseId,
      event.eventType,
      event.payloadBefore == null ? null : JSON.stringify(event.payloadBefore),
      event.payloadAfter == null ? null : JSON.stringify(event.payloadAfter),
      event.causedByEntityType ?? null,
      event.causedByEntityId ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DocumentEventType = "document.uploaded" | "document.verified" | "document.rejected";

export interface DocumentEvent {
  readonly actorUserId: string;
  readonly documentId: string;
  readonly caseId: string;
  readonly eventType: DocumentEventType;
  readonly payloadAfter?: Record<string, unknown> | null;
}

/**
 * Record one change to a document.
 *
 * `case_id` is set so the document's history appears on the case timeline
 * even though the document itself is owned by a person, property or
 * organisation, never the case (ADR-007) — a document travels with the
 * person, but the act of uploading it happened in the context of one case.
 *
 * WHAT MAY GO IN THE PAYLOAD: ids, document type, requirement id, version. A
 * rejection's free-text reason is not personal data about a named human the
 * way `hold_reason` is — it is a note about a document's quality ("photo is
 * blurred") — but it stays out of the payload anyway, on the same discipline
 * this file already applies everywhere else: it lives on
 * `document_requirement.reason`, which redaction can reach, rather than in a
 * log that never is.
 */
export async function recordDocumentEvent(client: Queryable, event: DocumentEvent): Promise<void> {
  await client.query(
    `insert into event (actor_kind, actor_user_id, entity_type, entity_id, case_id,
                        event_type, payload_after, source)
     values ('user', $1, 'document', $2, $3, $4, $5, 'ui')`,
    [
      event.actorUserId,
      event.documentId,
      event.caseId,
      event.eventType,
      event.payloadAfter == null ? null : JSON.stringify(event.payloadAfter),
    ],
  );
}
