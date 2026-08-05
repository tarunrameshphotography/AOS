-- ===========================================================================
-- 0004 — Cases
--
-- A lead is a case in an early stage. There is no separate Lead entity and no
-- conversion step, because every convert-from-X-to-Y seam produces duplicate
-- records and severed history (ADR-008). One object means a case's timeline runs
-- unbroken from first phone call to disbursement.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- case_number_sequence
-- ---------------------------------------------------------------------------
create table case_number_sequence (
  year       integer primary key,
  last_value integer not null default 0,

  constraint case_number_sequence_year_sane check (year between 2000 and 9999),
  constraint case_number_sequence_value_not_negative check (last_value >= 0)
);

comment on table case_number_sequence is
  'One row per calendar year holding the last allocated case number. A counter '
  'rather than a Postgres sequence because sequences gap on every rolled-back '
  'transaction, and a customer quoting AL-2026-00087 when the company has opened '
  '71 cases invites a question with no good answer. At ~10 cases a month the '
  'serialisation cost is nil and contiguity is worth more than the concurrency '
  '(ADR-024). Year rollover is a new row, not a migration. Not readable by any '
  'client: the counter is not information anyone needs, and exposing it would '
  'invite reports that treat case numbers as a count of business done, which '
  'they are not.';

-- ---------------------------------------------------------------------------
-- loan_case
-- ---------------------------------------------------------------------------
create table loan_case (
  id               uuid primary key default gen_random_uuid(),

  -- AL-YYYY-NNNNN. Quoted on the phone, printed on a login form, and NOTHING
  -- JOINS ON IT. The UUID above is the identity (ADR-024) — this is ADR-013
  -- applied to cases rather than people: a business identifier that anything
  -- depends on becomes a thing that cannot be changed when the business
  -- changes.
  case_number      text not null unique,

  loan_product_id  uuid not null references loan_product (id),
  requested_amount numeric(14, 2),

  stage            app.case_stage not null default 'new',

  -- Exactly one accountable owner at any moment. Ownership can change; it
  -- cannot be absent or shared, because shared accountability is no
  -- accountability (BR-011).
  owner_user_id    uuid not null references app_user (id),

  source           text,

  -- Lost is terminal but reopenable. stage_before_lost is what a reopened case
  -- returns to — a postponed customer returning in six months is common, and
  -- creating a fresh case would sever the earlier conversation from the new one.
  lost_reason      app.lost_reason,
  lost_note        text,
  stage_before_lost app.case_stage,
  lost_at          timestamptz,
  duplicate_of_case_id uuid references loan_case (id),

  -- Hold is orthogonal to stage and coexists with any non-terminal stage
  -- (ADR-021). A held case is still at whatever stage it reached, and when the
  -- hold lifts you must know where to resume. Absent a first-class hold, users
  -- improvise by parking cases in a wrong stage, and the stage data stops being
  -- trustworthy — silently and permanently.
  is_on_hold       boolean not null default false,
  hold_reason      text,
  hold_until       date,

  -- Closing asserts the invoice is raised. Read by the disbursed -> closed
  -- transition guard in src/domain/case/transitions.ts.
  is_invoice_raised boolean not null default false,

  created_at       timestamptz not null default now(),
  created_by       uuid references app_user (id),
  updated_at       timestamptz not null default now(),
  closed_at        timestamptz,

  constraint loan_case_number_format check (case_number ~ '^AL-\d{4}-\d{5,}$'),

  -- Lost always carries a reason: lost cases are the most instructive data the
  -- company will accumulate, and free text alone cannot be analysed (BR-013).
  constraint loan_case_lost_is_complete
    check ((stage = 'lost') = (lost_reason is not null)),
  constraint loan_case_lost_timestamped
    check ((lost_reason is null) = (lost_at is null)),

  -- A terminal stage is not a stage a case can be held in. Hold exists so a
  -- stalled case stops generating noise without being forgotten; a lost case is
  -- not stalled, it is over.
  constraint loan_case_hold_is_complete
    check (is_on_hold = (hold_reason is not null)),
  constraint loan_case_hold_is_not_terminal
    check (not is_on_hold or stage not in ('closed', 'lost')),

  constraint loan_case_closed_timestamped
    check ((stage = 'closed') = (closed_at is not null)),
  constraint loan_case_closed_needs_invoice
    check (stage <> 'closed' or is_invoice_raised),

  constraint loan_case_duplicate_is_not_self
    check (duplicate_of_case_id is null or duplicate_of_case_id <> id),

  constraint loan_case_requested_amount_positive
    check (requested_amount is null or requested_amount > 0)
);

comment on table loan_case is
  'One loan application journey — the centre of the system. A lead is a case in '
  'an early stage; there is no separate Lead entity and no conversion step '
  '(ADR-008). Named loan_case because "case" is reserved in SQL. Required by '
  'BR-010 through BR-014. There is no status column: stage already carries lost '
  'and closed, and a second status field would be a duplicate state that can '
  'disagree with the first (audit finding A8). A case is never hard-deleted '
  '(BR-013). PRD/Loan Lifecycle.md, PRD/Workflow.md, PRD/Data Model.md.';

comment on column loan_case.case_number is
  'Immutable after insert, enforced by trigger below. Nothing is encoded in it: '
  'a case whose loan product changes mid-case is supported, and an encoded '
  'number would either be wrong forever or force a renumbering (ADR-024).';

comment on column loan_case.stage is
  'Stored, auto-advanced by submission changes, and always evented (ADR-019). '
  'Deriving it on read would make it unstorable, unindexable and ambiguous — '
  '"best submission" has no single definition when one bank sanctions and '
  'another rejects. Auto-advance is one-directional: a rejection never moves a '
  'case backwards, because other submissions may still be live.';

comment on column loan_case.duplicate_of_case_id is
  'Two telecallers logged the same enquiry. Resolved by marking one lost with '
  'reason duplicate_case and linking it here. Cases are NOT merged — merging is '
  'for identities, not for process records, because two cases genuinely happened '
  'and both timelines are true (PRD/Workflow.md).';

create index loan_case_owner_idx on loan_case (owner_user_id) where stage not in ('closed', 'lost');
create index loan_case_stage_idx on loan_case (stage);
create index loan_case_product_idx on loan_case (loan_product_id);

-- Every active-case query must account for the hold flag (ADR-021), so the
-- index that serves "needs attention" exists once, here, rather than being
-- rediscovered per screen.
create index loan_case_attention_idx
  on loan_case (owner_user_id, stage)
  where stage not in ('closed', 'lost') and not is_on_hold;

create index loan_case_hold_expiry_idx on loan_case (hold_until) where is_on_hold;

-- ---------------------------------------------------------------------------
-- Case number: allocation and immutability
-- ---------------------------------------------------------------------------

create or replace function app.allocate_case_number(p_year integer default null)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_year  integer := coalesce(p_year, extract(year from now())::integer);
  v_value integer;
begin
  -- One row locked per allocation. Serialising case creation is acceptable at
  -- ~10 cases a month, and contiguous numbers within a year are worth more than
  -- the concurrency (ADR-024).
  insert into case_number_sequence (year, last_value)
  values (v_year, 1)
  on conflict (year) do update
    set last_value = case_number_sequence.last_value + 1
  returning last_value into v_value;

  return format('AL-%s-%s', v_year, lpad(v_value::text, 5, '0'));
end;
$$;

comment on function app.allocate_case_number is
  'Allocates the next case number for a year, creating the year''s counter row '
  'on first use. SECURITY DEFINER because case_number_sequence is not readable '
  'or writable by any client — a client that could increment the counter could '
  'skip numbers. Format matches formatCaseNumber() in '
  'src/domain/case/case-number.ts; the two must stay in step (ADR-024).';

create or replace function app.reject_case_number_change()
returns trigger
language plpgsql
as $$
begin
  if new.case_number is distinct from old.case_number then
    raise exception 'case_number is immutable (ADR-024): % cannot become %',
      old.case_number, new.case_number
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger loan_case_number_immutable
  before update on loan_case
  for each row execute function app.reject_case_number_change();

-- ---------------------------------------------------------------------------
-- case_party
-- ---------------------------------------------------------------------------
create table case_party (
  id              uuid primary key default gen_random_uuid(),
  case_id         uuid not null references loan_case (id),

  person_id       uuid references person (id),
  organisation_id uuid references organisation (id),

  role            app.case_party_role not null,
  is_primary      boolean not null default false,

  removed_at      timestamptz,
  removed_by      uuid references app_user (id),

  created_at      timestamptz not null default now(),
  created_by      uuid references app_user (id),
  updated_at      timestamptz not null default now(),

  -- Exactly one reference, never both and never neither.
  constraint case_party_has_one_subject
    check ((person_id is null) <> (organisation_id is null)),

  -- And which one is not free. A guarantor that is an organisation, or a
  -- borrowing firm that is a person, is not a thing. Enforced here rather than
  -- in the application because it is exactly the kind of rule that holds until
  -- the one code path nobody remembered.
  constraint case_party_role_matches_subject
    check (
      case role
        when 'borrower_firm' then organisation_id is not null
        else person_id is not null
      end
    ),

  constraint case_party_primary_is_applicant
    check (not is_primary or role = 'applicant'),

  constraint case_party_removal_is_complete
    check ((removed_at is null) = (removed_by is null))
);

comment on table case_party is
  'The parties on a case. A case does not have "a customer": it has an '
  'applicant, usually a co-applicant, sometimes a guarantor, often a referrer. '
  'Home loans in particular are almost always joint, so case.customer_id would '
  'be wrong on day one. Exactly one primary applicant is the ONLY mandatory '
  'party (BR-010); every other role is optional and absent by default, '
  'generating no row, no requirement and no interface element (BR-012, ADR-010). '
  'PRD/Data Model.md, PRD/Requirements and Progress.md Part 1.';

comment on column case_party.removed_at is
  'Removal is a timestamp, not a delete: that party''s requirements become '
  'not_applicable (PRD/Workflow.md), and the fact that the case once had a '
  'co-applicant is what the timeline is for.';

-- BR-010, at the database rather than in application code.
create unique index case_party_one_primary_applicant
  on case_party (case_id)
  where is_primary and removed_at is null;

-- A party appears at most once per role per case.
create unique index case_party_unique_person_role
  on case_party (case_id, role, person_id)
  where person_id is not null and removed_at is null;

create unique index case_party_unique_organisation_role
  on case_party (case_id, role, organisation_id)
  where organisation_id is not null and removed_at is null;

-- The case-derived `own` predicate reaches into this table, so it is on the hot
-- path of nearly every read and is indexed deliberately rather than
-- incidentally (ADR-027).
create index case_party_person_idx on case_party (person_id) where removed_at is null;
create index case_party_organisation_idx on case_party (organisation_id) where removed_at is null;
create index case_party_case_idx on case_party (case_id) where removed_at is null;

-- ---------------------------------------------------------------------------
-- case_property
-- ---------------------------------------------------------------------------
create table case_property (
  id          uuid primary key default gen_random_uuid(),
  case_id     uuid not null references loan_case (id),
  property_id uuid not null references property (id),
  role        app.case_property_role not null,

  removed_at  timestamptz,
  removed_by  uuid references app_user (id),

  created_at  timestamptz not null default now(),
  created_by  uuid references app_user (id),
  updated_at  timestamptz not null default now(),

  constraint case_property_removal_is_complete
    check ((removed_at is null) = (removed_by is null))
);

comment on table case_property is
  'Links a case to the properties involved. A property changed mid-case stays '
  'linked to the case''s history rather than being unlinked (PRD/Workflow.md — '
  'edge cases): property-linked requirements regenerate, but the old link is '
  'part of what happened. Referenced in prose and the relationship diagram but '
  'never given an entity block until the consistency audit (finding C2). '
  'PRD/Data Model.md.';

create unique index case_property_unique
  on case_property (case_id, property_id)
  where removed_at is null;

create index case_property_property_idx on case_property (property_id) where removed_at is null;
create index case_property_case_idx on case_property (case_id) where removed_at is null;

create trigger loan_case_touch     before update on loan_case     for each row execute function app.touch_updated_at();
create trigger case_party_touch    before update on case_party    for each row execute function app.touch_updated_at();
create trigger case_property_touch before update on case_property for each row execute function app.touch_updated_at();
