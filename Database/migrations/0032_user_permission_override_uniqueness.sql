-- ===========================================================================
-- 0032 — One live permission override per user per permission
--
-- WHY THIS EXISTS: 0029 created `user_permission_override` with no uniqueness
-- rule, because at the time nothing wrote to it — the Employee Authentication
-- milestone put overrides on an in-memory object and the table was created
-- ahead of a writer. Stage 3A of the Persistence milestone is that writer, and
-- writing exposes the gap.
--
-- Without this index a user can hold two live rows for the same permission —
-- say a `grant` at `own` and a `grant` at `all`, or a `grant` and a `deny`.
-- `hasPermissionWithOverrides` still answers deterministically (deny beats
-- grant, widest grant wins), so nothing is ambiguous to the CODE. It is
-- ambiguous to the PEOPLE: the User Management screen has to render "what did
-- someone decide about this permission for this person", and two live rows
-- have no single answer to show, nor one row to revoke when the decision is
-- reversed. An override is a decision about a permission, and a person holds
-- one current decision at a time.
--
-- Setting an override therefore revokes the live one first and inserts a new
-- row (Backend/users.ts), exactly as replacing a role assignment does. The
-- history is preserved either way — revoked, never deleted, per 0029's
-- comment — so "what were they granted last month" survives untouched.
--
-- Deliberately mirrors `user_role_one_live_grant` from 0002, including the
-- partial predicate: the constraint applies to live rows only, so a permission
-- can be granted, revoked and granted again without colliding with its own
-- history.
-- ===========================================================================

create unique index user_permission_override_one_live_decision
  on user_permission_override (user_id, permission)
  where revoked_at is null;

comment on index user_permission_override_one_live_decision is
  'A user holds at most one live override per permission. Reversing a decision '
  'revokes the existing row and inserts a new one; it never leaves two live '
  'rows for the application to reconcile.';
