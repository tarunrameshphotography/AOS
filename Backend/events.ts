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
