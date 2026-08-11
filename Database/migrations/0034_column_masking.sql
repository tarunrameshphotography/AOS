-- ===========================================================================
-- 0034 — Column masking (ADR-026, Production Readiness Phase 1)
--
-- WHAT WAS WRONG. `aos_app` has held `SELECT` on `person_identifier`,
-- `referrer_profile` and `submission` in full since migration 0033, and
-- `Backend/customers.ts` / `Backend/cases.ts` read `value_raw` straight onto
-- every customer and every case row. Anyone holding ordinary `person.read` or
-- `case.read` — every employee — received the full PAN, bank account number
-- and phone number of every person they could otherwise see, because nothing
-- ever checked `identifier.view_full`. `src/domain/permissions/tables.ts` has
-- declared these columns masked since ADR-026 was accepted; nothing enforced
-- the declaration.
--
-- THE SHAPE OF THE FIX, and why it is not a SQL re-implementation of
-- `authorize.ts`. `identifier.view_full` is a PER-RECORD disclosure decision
-- (DECISIONS.md ADR-026): revealing one PAN is one event, not a standing grant
-- that unmasks every list a permitted employee ever loads. So the masked view
-- below masks UNCONDITIONALLY — it does not branch on `app.has_permission`,
-- because branching there would make bulk export of every identifier in the
-- system a single unaudited query for anyone holding the permission, which is
-- the opposite of what "per-record, always audited" means. The one path to a
-- raw value is `app.reveal_identifier_value`, a narrow SECURITY DEFINER getter
-- with no authorization logic of its own — the decision is `can(actor,
-- "identifier.view_full", "all")` in `Backend/customers.ts`, the same function
-- and the same `role_permission`/`user_permission_override` data every other
-- permission check in AOS uses. Putting the decision in SQL as well would be
-- the second permission system ADR-022 forbids, and it would silently ignore
-- `user_permission_override`, which the SQL-side `app.has_permission` has
-- never read. The getter exists purely so `aos_app` — which this migration
-- also stops granting raw `SELECT` on `value_raw` — has exactly one narrow,
-- named door to that column, called only after the one authority has already
-- said yes.
--
-- `commercial.view` (`referrer_profile.commission_terms`,
-- `submission.login_fee_amount`) is the other shape ADR-026 describes: a
-- whole-surface permission, not a per-record one. Nothing in `Backend/` reads
-- either column today (confirmed by search) — there is no screen to retrofit.
-- Both are masked unconditionally here too, for the same reason 0010 enables
-- RLS with no policy before any policy exists: a column that ships masked and
-- unreachable is a safe default; a column that ships open because "nothing
-- reads it yet" is a trap for whoever adds the first reader. Wiring a
-- `commercial.view`-gated reveal path is deferred to whichever future slice
-- actually builds that screen, the same way `identifier.view_full`'s reveal
-- path arrives now because Phase 1 is the slice that needs it.
--
-- DOB, ADDRESS, PINCODE ARE DELIBERATELY UNTOUCHED. ADR-026 states plainly:
-- "Two permissions are column-level and no others." `person.date_of_birth`,
-- `address_line`, `locality`, `city`, `district`, `state` and `pincode` stay
-- governed by `person.read` alone, exactly as `tables.ts` already documents.
-- This is not an oversight surfaced late; it is the ADR's own closed answer,
-- confirmed by re-reading it for this migration rather than assumed.
--
-- Additive only: no existing migration is edited, no table is dropped or
-- renamed, no row is touched. `person_identifier`, `referrer_profile` and
-- `submission` keep their existing INSERT/UPDATE grants — writes are
-- unaffected, per ADR-026 ("writes go to base tables through the domain
-- layer, which is where they belonged anyway").
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- app.mask_last4 — the one masking rule, applied identically everywhere
--
-- Matches `tables.ts`'s own description of the mask: "last four characters,
-- the rest as x". Length-preserving, so a masked PAN and a masked phone
-- number still read as roughly what they are without being reconstructable.
-- A value of length 4 or less is masked entirely rather than shown whole —
-- "the rest as x" would otherwise mask nothing on a 4-character value.
-- ---------------------------------------------------------------------------

create or replace function app.mask_last4(p_value text)
returns text
language sql
immutable
as $$
  select case
           when p_value is null then null
           when length(p_value) <= 4 then repeat('x', length(p_value))
           else repeat('x', length(p_value) - 4) || right(p_value, 4)
         end;
$$;

comment on function app.mask_last4 is
  'The ADR-026 masking rule: last four characters visible, the rest replaced '
  'with x, length preserved. Used by every masked view in this migration so '
  'the mask reads the same way regardless of which column it is hiding.';

-- ---------------------------------------------------------------------------
-- person_identifier_v — what a normal person.read holder actually gets
--
-- value_normalised is not exposed at all: it is the search key
-- (`Backend/customers.ts`'s `listCustomers` matches against it directly on
-- the base table, which still has to work), and `tables.ts` already treats it
-- as masked identically to value_raw, so there is no reason for a client to
-- receive it in any form.
-- ---------------------------------------------------------------------------

create or replace view person_identifier_v as
select
  id,
  person_id,
  identifier_type,
  app.mask_last4(value_raw) as value_display,
  is_primary,
  valid_from,
  valid_to,
  verification_source,
  created_at,
  updated_at
from person_identifier;

comment on view person_identifier_v is
  'The client-facing shape of person_identifier (ADR-026). value_display is '
  'ALWAYS masked, regardless of who is asking — identifier.view_full does not '
  'widen this view, because full disclosure is a per-record, always-audited '
  'action (app.reveal_identifier_value), not a standing grant. Backend/ reads '
  'this view for every list, search result and case row; it never selects '
  'value_raw directly outside app.reveal_identifier_value.';

-- Column-level REVOKE has no effect on top of a table-level GRANT SELECT —
-- 0033 granted the whole table, and table-level and column-level ACL entries
-- are independent: the table-level entry keeps satisfying every column check
-- regardless of what a narrower REVOKE says. The table-level SELECT has to
-- come off first, then SELECT is re-granted column by column, everything
-- except value_raw. Driven from information_schema rather than a hand-typed
-- list: `submission` below has grown seven columns since its founding
-- migration (0024's snapshot columns) that a hand-typed list on THIS migration
-- would have no reason to know about, and getting that list wrong silently
-- breaks Backend/submissions.ts rather than failing the migration.
revoke select on person_identifier from aos_app;

do $$
declare
  col text;
begin
  for col in
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'person_identifier'
       and column_name <> 'value_raw'
  loop
    execute format('grant select (%I) on person_identifier to aos_app', col);
  end loop;
end;
$$;

grant select on person_identifier_v to aos_app;

-- ---------------------------------------------------------------------------
-- app.reveal_identifier_value — the one door to a raw identifier value
--
-- Deliberately does NOT check a permission. The decision was already made by
-- `can(actor, "identifier.view_full", "all")` in Backend/customers.ts before
-- this is ever called — see the migration header for why duplicating that
-- check here would be a second, drifting authorization system. What this
-- function buys is narrower than authorization: even a SQL injection or a
-- future careless `select value_raw from person_identifier` cannot reach the
-- column, because aos_app's only route to it is this one named function.
--
-- STABLE, not VOLATILE: it writes nothing and its result depends only on its
-- argument and the current row, so the planner may fold repeated calls in one
-- statement. SECURITY DEFINER so it runs with the owner's privileges, the
-- same pattern as app.current_user_id and app.has_permission (0010).
--
-- Subject to person_identifier's tier-B RLS policy exactly as a direct query
-- would be, because 0010 enabled RLS with FORCE — which applies to the table
-- owner too, and this function is SECURITY DEFINER precisely so it runs as
-- the owner. An unauthenticated connection (no app.auth_identity_id
-- published) gets no row and therefore null, the same refusal every other
-- operational table gives it.
-- ---------------------------------------------------------------------------

create or replace function app.reveal_identifier_value(p_identifier_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select value_raw from person_identifier where id = p_identifier_id;
$$;

comment on function app.reveal_identifier_value is
  'Returns the raw value of one identifier, or null if it does not exist (or '
  'the caller has no published identity). Carries no authorization logic of '
  'its own — Backend/customers.ts checks identifier.view_full via can() and '
  'records the audit event both when it calls this and when it refuses to. '
  'This is the ONLY function or view in the schema that can produce a raw '
  'identifier value; aos_app holds no other route to person_identifier.value_raw.';

grant execute on function app.reveal_identifier_value(uuid) to aos_app;

-- ---------------------------------------------------------------------------
-- referrer_profile_v, submission_v — commercial.view's masked surfaces
--
-- Masked unconditionally, same reasoning as person_identifier_v: no route in
-- Backend/ reads either column today, so there is no existing behaviour to
-- preserve and no reveal path to build yet. A future screen that needs
-- commission_terms or login_fee_amount for a commercial.view holder adds a
-- narrow reveal alongside that screen, following app.reveal_identifier_value
-- as the template — checked in TypeScript via can(), not in this view.
-- ---------------------------------------------------------------------------

create or replace view referrer_profile_v as
select
  person_id,
  referrer_type,
  null::text as commission_terms_display,
  (commission_terms is not null) as has_commission_terms,
  is_active,
  created_at,
  updated_at
from referrer_profile;

comment on view referrer_profile_v is
  'The client-facing shape of referrer_profile (ADR-026). commission_terms is '
  'masked unconditionally: has_commission_terms says whether terms exist, '
  'commission_terms_display never carries the text. No Backend/ route reads '
  'referrer_profile today; this view is the safe default for whichever route '
  'reads it first.';

-- Same table-level-vs-column-level reasoning as person_identifier above.
revoke select on referrer_profile from aos_app;

do $$
declare
  col text;
begin
  for col in
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'referrer_profile'
       and column_name <> 'commission_terms'
  loop
    execute format('grant select (%I) on referrer_profile to aos_app', col);
  end loop;
end;
$$;

grant select on referrer_profile_v to aos_app;

create or replace view submission_v as
select
  id,
  case_id,
  branch_organisation_id,
  bank_product_id,
  bank_contact_id,
  status,
  status_note,
  submitted_by,
  submitted_at,
  rejection_reason_id,
  bank_reason_text,
  rejected_at,
  null::numeric(12, 2) as login_fee_amount_display,
  (login_fee_amount is not null) as has_login_fee,
  login_fee_paid_at,
  bank_reference_number,
  created_at,
  created_by,
  updated_at,
  institution_organisation_id,
  submission_mode_id,
  bank_name_at_submission,
  branch_name_at_submission,
  branch_address_at_submission,
  branch_city_at_submission,
  snapshot_taken_at
from submission;

comment on view submission_v is
  'The client-facing shape of submission (ADR-026). login_fee_amount is '
  'masked unconditionally: has_login_fee says whether a fee was recorded, '
  'login_fee_amount_display never carries the figure. No Backend/ route reads '
  'login_fee_amount today; this view is the safe default for whichever route '
  'reads it first.';

-- Same table-level-vs-column-level reasoning as person_identifier above.
revoke select on submission from aos_app;

do $$
declare
  col text;
begin
  for col in
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'submission'
       and column_name <> 'login_fee_amount'
  loop
    execute format('grant select (%I) on submission to aos_app', col);
  end loop;
end;
$$;

grant select on submission_v to aos_app;
