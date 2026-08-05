-- ===========================================================================
-- 0006 — Submissions and offers
--
-- A case submitted to five banks has five different truths at once — sanctioned
-- at one, rejected at another, pending at three. A single stage column cannot
-- express that, so the real state would end up in free-text notes, outside
-- search and reporting (ADR-004).
--
-- This is where the real work lives.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- submission
-- ---------------------------------------------------------------------------
create table submission (
  id                     uuid primary key default gen_random_uuid(),
  case_id                uuid not null references loan_case (id),

  -- The BRANCH, not the bank, is the counterparty: a file physically goes to a
  -- specific place and a specific relationship manager works it. The same
  -- bank's Madurai and Chennai branches function as different counterparties
  -- for a given file (ADR-015).
  branch_organisation_id uuid not null references organisation (id),

  bank_product_id        uuid references bank_product (id),
  bank_contact_id        uuid references bank_contact (id),

  status                 app.submission_status not null default 'not_submitted',
  status_note            text,

  -- Dispatch, not row creation. The case stage advances when a submission
  -- leaves not_submitted (PRD/Workflow.md, corrected reading A7). A submission
  -- sitting in not_submitted is a real state — chosen bank, product and
  -- contact, file not yet gone out — and a long stay there is a health signal,
  -- not an error.
  submitted_by           uuid references app_user (id),
  submitted_at           timestamptz,

  -- Two layers, and the pairing is the whole point (ADR-028).
  -- rejection_reason_id is Amaze's standardised category and is what reports
  -- group by. bank_reason_text is what the bank actually said, verbatim, and is
  -- what proves the category was chosen honestly when somebody later disputes
  -- the classification.
  rejection_reason_id    uuid references rejection_reason (id),
  bank_reason_text       text,
  rejected_at            timestamptz,

  -- Masked behind commercial.view (ADR-026): that a fee was paid is visible to
  -- everyone working the file; the figure is not.
  login_fee_amount       numeric(12, 2),
  login_fee_paid_at      timestamptz,

  bank_reference_number  text,

  created_at             timestamptz not null default now(),
  created_by             uuid references app_user (id),
  updated_at             timestamptz not null default now(),

  -- BR-024: a rejection always carries a standardised category. Free text alone
  -- cannot be analysed, and this reason set becomes the most commercially
  -- valuable data the company accumulates.
  constraint submission_rejection_is_categorised
    check ((status = 'rejected') = (rejection_reason_id is not null)),
  constraint submission_rejection_timestamped
    check ((rejection_reason_id is null) = (rejected_at is null)),

  -- BR-026: the bank's wording never stands alone.
  constraint submission_bank_reason_accompanies_category
    check (bank_reason_text is null or rejection_reason_id is not null),

  -- Dispatched means dispatched: anything that reached a bank has a time and a
  -- person attached to it. `withdrawn` is exempt because withdrawing a file
  -- before it goes out is legitimate — that is our choice to stop, and it can be
  -- made at any point including before dispatch.
  constraint submission_dispatch_is_attributed
    check ((submitted_at is null) = (submitted_by is null)),
  constraint submission_progressed_means_dispatched
    check (status in ('not_submitted', 'withdrawn') or submitted_at is not null),

  constraint submission_login_fee_is_complete
    check ((login_fee_amount is null) = (login_fee_paid_at is null)),
  constraint submission_login_fee_not_negative
    check (login_fee_amount is null or login_fee_amount >= 0)
);

comment on table submission is
  'A case sent to one bank branch, carrying its own independent status. Case '
  'stage and submission status are different axes and neither can express the '
  'other (ADR-004, BR-021). Required by BR-020: a submission belongs to exactly '
  'one case and exactly one branch, and cannot exist without both. A rejected '
  'file corrected and sent back to the same branch is a NEW submission, never a '
  'status reset — the rejection is history and must survive, and a reset would '
  'erase the fact the bank ever said no (PRD/Workflow.md). '
  'PRD/Data Model.md, PRD/Workflow.md.';

comment on column submission.status is
  'Not a linear chain: query_raised loops back to under_process — the single '
  'most common real-world transition — and rejected/withdrawn are exits '
  'reachable from several points. Withdrawn is OUR choice to stop; rejected is '
  'theirs, and conflating them destroys the value of the rejection dataset.';

-- BR-022, at the database rather than merely unlikely. Two disbursements on one
-- case would be a serious error.
create unique index submission_one_disbursed_per_case
  on submission (case_id)
  where status = 'disbursed';

create index submission_case_idx on submission (case_id);
create index submission_branch_idx on submission (branch_organisation_id);
create index submission_status_idx on submission (status);
create index submission_rejection_reason_idx
  on submission (rejection_reason_id)
  where rejection_reason_id is not null;

-- "Live at a bank, awaiting response beyond expected turnaround" — a case-health
-- input (PRD/Requirements and Progress.md Part 4).
create index submission_awaiting_response_idx
  on submission (submitted_at)
  where status in ('submitted', 'under_process', 'query_raised', 'eligibility_received');

-- ---------------------------------------------------------------------------
-- submission_query
-- ---------------------------------------------------------------------------
create table submission_query (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references submission (id),
  raised_at     timestamptz not null default now(),
  question      text not null,
  answered_at   timestamptz,
  answer        text,
  answered_by   uuid references app_user (id),

  constraint submission_query_answer_is_complete
    check ((answered_at is null) = (answer is null))
);

comment on table submission_query is
  'One query raised by a bank, with what was asked and what was sent. '
  'query_raised -> under_process is a loop, and each pass must be recorded '
  'separately because "how many queries did this branch raise?" is a real '
  'question about that branch — a status that merely oscillates answers it with '
  '"one" (PRD/Workflow.md). Required by the transition rules; without this table '
  'the loop is lossy.';

create index submission_query_submission_idx on submission_query (submission_id);
create index submission_query_open_idx on submission_query (submission_id) where answered_at is null;

-- ---------------------------------------------------------------------------
-- offer
-- ---------------------------------------------------------------------------
create table offer (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid not null references submission (id),

  sanctioned_amount numeric(14, 2) not null,
  interest_rate     numeric(5, 2),
  tenure_months     integer,
  processing_fee    numeric(12, 2),
  conditions        text,

  -- An expired sanction does not reverse the case stage — the bank sanctioned,
  -- and that fact happened. It raises a task and flags the case's health
  -- (PRD/Workflow.md — edge cases).
  valid_until       date,

  is_accepted       boolean not null default false,
  accepted_at       timestamptz,
  accepted_by       uuid references app_user (id),

  created_at        timestamptz not null default now(),
  created_by        uuid references app_user (id),
  updated_at        timestamptz not null default now(),

  constraint offer_amount_positive check (sanctioned_amount > 0),
  constraint offer_rate_sane check (interest_rate is null or (interest_rate > 0 and interest_rate < 100)),
  constraint offer_tenure_positive check (tenure_months is null or tenure_months > 0),
  constraint offer_acceptance_is_complete
    check (is_accepted = (accepted_at is not null) and (accepted_at is null) = (accepted_by is null))
);

comment on table offer is
  'What a bank came back with. Separate from submission because a bank can '
  'revise an offer, and comparing the original against the revision is the '
  'conversation you have with the customer. Required by BR-023: a submission '
  'cannot enter Sanctioned without an attached offer, because "sanctioned" with '
  'no amount, rate or tenure is not information. PRD/Data Model.md.';

-- BR-025: accepting two competing offers from one bank is meaningless.
create unique index offer_one_accepted_per_submission
  on offer (submission_id)
  where is_accepted;

create index offer_submission_idx on offer (submission_id);
create index offer_expiring_idx on offer (valid_until) where valid_until is not null and not is_accepted;

-- ---------------------------------------------------------------------------
-- BR-023 as a state invariant
--
-- The division of labour, stated once because it decides where every future
-- rule goes:
--
--   The database enforces STATE invariants — what must be true of stored data
--   at commit. The domain layer enforces TRANSITIONS — which moves are legal
--   from where, and why a refusal happened in words a user can act on.
--
-- These are not two implementations of one rule. `sanctionHasOffer` in
-- src/domain/case/transitions.ts refuses the move and explains why; this
-- refuses the *resulting state* however it was reached, including by a path
-- nobody has written yet. BR-022 has exactly the same shape, enforced above as
-- a unique index.
--
-- A rule that is only a transition guard is not enforced here, and a rule that
-- is only a stored-state fact is not restated there.
-- ---------------------------------------------------------------------------

create or replace function app.assert_sanction_has_offer()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('sanctioned', 'disbursed')
     and not exists (select 1 from offer where offer.submission_id = new.id)
  then
    raise exception
      'Submission % cannot be % without an offer attached (BR-023).',
      new.id, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

-- DEFERRABLE INITIALLY DEFERRED so the offer and the status change may be
-- written in either order within one transaction. Recording a sanction is
-- naturally "here is the offer, and the status is now sanctioned", and forcing
-- an order would push a workaround into every caller.
create constraint trigger submission_sanction_has_offer
  after insert or update of status on submission
  deferrable initially deferred
  for each row execute function app.assert_sanction_has_offer();

create trigger submission_touch before update on submission for each row execute function app.touch_updated_at();
create trigger offer_touch      before update on offer      for each row execute function app.touch_updated_at();
