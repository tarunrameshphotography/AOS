-- ===========================================================================
-- 0024 — Bank Submission Workflow
--
-- "Send to Bank" was one dropdown of branches. What actually happens is that
-- somebody picks a bank, then a branch of it, then names the bankers the file
-- should reach — usually more than one, because a file sent only to the
-- relationship manager stalls the week they are on leave.
--
-- Three changes, all additive:
--
--   1. `bank_contact` becomes the contact model the office needs: a contact
--      belongs to a BRANCH, may have no name, and one per branch is primary.
--   2. `submission` carries a SNAPSHOT of the bank and branch it went to.
--   3. `submission_recipient` records who it was addressed to, snapshotted
--      the same way.
--
-- WHAT THIS MIGRATION DOES NOT DO, and must not be extended to do: send
-- anything. No Gmail, no Outlook, no draft, no attachment packaging, no size
-- splitting. Those are later milestones, and the seam they attach to is named
-- at the bottom of this file.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Part 1 — contacts belong to branches, and a contact is not always a person
--
-- ADR-034 established that a work mobile and a bank email address belong to
-- the POSTING, not to the human being — which is why they sit here and not on
-- `person_identifier`. This migration follows that same thought one step
-- further and reaches a conclusion ADR-034 did not need to: for a great many
-- of the addresses a file is actually sent to, there is no human being to
-- model at all.
--
-- `homeloans.cbe@examplebank.com` is a desk. `manager.rspuram@...` is a chair.
-- Under the old shape, recording either meant inventing a `person` row with a
-- fabricated name, which is precisely the "fictional people in an operational
-- contact list" that Milestone 8 refused to seed. So `person_id` becomes
-- optional, and `contact_name` holds the name as the office typed it.
--
-- The link to `person` is KEPT, not replaced: when the contact is a real
-- manager whose identity Amaze wants to follow across a move between banks,
-- that is exactly the relationship ADR-006 and ADR-014 model, and nothing
-- about it changes.
-- ---------------------------------------------------------------------------

alter table bank_contact
  add column contact_name       text,
  add column is_primary_contact boolean not null default false;

-- Backfill before relaxing anything, so no existing row loses its name.
update bank_contact bc
   set contact_name = p.full_name
  from person p
 where p.id = bc.person_id
   and bc.contact_name is null;

alter table bank_contact alter column person_id drop not null;

alter table bank_contact
  add constraint bank_contact_is_identifiable
    check (
      person_id is not null
      or nullif(btrim(contact_name), '') is not null
      or nullif(btrim(work_email), '') is not null
    );

comment on column bank_contact.person_id is
  'The human being, when there is one. NULL for a desk or a shared mailbox — '
  '"homeloans.cbe@bank.com" is an address, not a person, and inventing a '
  '`person` row to hold it would put fictional people into an operational '
  'contact list. Kept rather than replaced by `contact_name`: a named manager '
  'who moves to another bank next year is one new bank_contact against the '
  'same person, which is the whole point of ADR-006 and ADR-014.';

comment on column bank_contact.contact_name is
  'The name as the office recorded it, and the display name for this contact. '
  'Optional: a submission can legitimately be addressed to an address whose '
  'owner nobody at Amaze has met. Backfilled from person.full_name for every '
  'row that existed before 0024.';

comment on column bank_contact.is_primary_contact is
  'The one contact at this branch a file goes to first. At most one per '
  'branch among the active contacts, enforced by a partial unique index — a '
  'second "primary" is not a preference, it is a data entry mistake, and the '
  'workflow reads this column to pre-select a recipient.';

comment on constraint bank_contact_is_identifiable on bank_contact is
  'A contact must be reachable or nameable as something. All three of person, '
  'name and email blank is an empty row, not a permissive one.';

-- At most one primary per branch, among contacts that are still current. A
-- contact who has moved on keeps its flag as a record of what was true.
create unique index bank_contact_one_primary_per_branch
  on bank_contact (branch_organisation_id)
  where is_primary_contact
    and is_active
    and branch_organisation_id is not null;

create index bank_contact_branch_active_idx
  on bank_contact (branch_organisation_id)
  where is_active and branch_organisation_id is not null;

-- ---------------------------------------------------------------------------
-- Part 2 — a submission remembers where it went
--
-- Master data is edited. A branch is renamed when the bank reorganises, moved
-- when the lease ends, closed when the bank consolidates. Under the old shape
-- every one of those edits silently rewrote history: a submission lodged at
-- "Indian Bank — RS Puram" in March would read as having gone to whatever that
-- row says today.
--
-- That is not a cosmetic problem. A rejection recorded against a branch is
-- evidence (ADR-028), and evidence that changes underneath you is not
-- evidence. So the live foreign keys stay — they are how you reach the branch
-- as it is NOW — and beside them sit plain text columns recording what it was
-- called WHEN THE FILE WENT. Both facts are true and neither can be derived
-- from the other.
--
-- Denormalisation is deliberate here and is not a violation of ADR-018's ban
-- on duplicated personal data: an institution is not a person, a branch name
-- is not personal data, and there is nothing here to redact.
-- ---------------------------------------------------------------------------

alter table submission
  -- The bank itself, alongside the branch. Reachable today through
  -- `organisation.parent_organisation_id`, but that link is master data like
  -- any other and a branch can be re-parented when banks merge — which is
  -- exactly when you least want the question "which bank was this?" to be
  -- answered by walking a mutable pointer.
  add column institution_organisation_id  uuid references organisation (id),

  -- How the file is going out. Master data since 0019 (at the branch, by
  -- email, lender portal, connector app, collected by the RM). This is the
  -- column a future Gmail or Outlook integration reads to know whether an
  -- email is even the right channel for this submission.
  add column submission_mode_id           uuid references submission_mode (id),

  -- The snapshot. Text, never foreign keys — the entire point is that these
  -- do not follow the master data.
  add column bank_name_at_submission      text,
  add column branch_name_at_submission    text,
  add column branch_address_at_submission text,
  add column branch_city_at_submission    text,
  add column snapshot_taken_at            timestamptz;

-- Backfill every existing submission from the master data as it stands today.
-- This is the best available answer and is honestly the only one: nothing
-- recorded what these branches were called last year. `snapshot_taken_at` is
-- left NULL for these rows precisely so they are distinguishable from a
-- snapshot genuinely taken at the moment of submission.
update submission s
   set institution_organisation_id  = coalesce(branch.parent_organisation_id, branch.id),
       bank_name_at_submission      = coalesce(institution.canonical_name, branch.canonical_name),
       branch_name_at_submission    = branch.canonical_name,
       branch_address_at_submission = bb.address_line,
       branch_city_at_submission    = coalesce(city.name, branch.city)
  from organisation branch
       left join organisation institution
              on institution.id = branch.parent_organisation_id
       left join bank_branch bb on bb.organisation_id = branch.id
       left join city on city.id = bb.city_id
 where branch.id = s.branch_organisation_id;

comment on column submission.institution_organisation_id is
  'The lending institution. The branch remains the counterparty (ADR-015) — '
  'this does not replace `branch_organisation_id` and is not a second way to '
  'address a file. It exists so "which bank?" survives a branch being '
  're-parented during a merger.';

comment on column submission.bank_name_at_submission is
  'The bank''s name AT THE MOMENT THIS SUBMISSION WAS CREATED. Text, not a '
  'foreign key, and deliberately denormalised: master data is edited, and an '
  'edit must never rewrite what a historical submission says it did. NULL '
  'only for rows that predate 0024.';

comment on column submission.snapshot_taken_at is
  'When the four *_at_submission columns were captured. NULL means the row '
  'predates 0024 and was backfilled from master data as it stood at migration '
  'time — a reconstruction, not a record. Anything reporting on historical '
  'accuracy must be able to tell the two apart.';

comment on column submission.submission_mode_id is
  'How this file goes out — at the branch, by email, through the lender '
  'portal (0019). Records intent only. NOTHING IN AOS SENDS ANYTHING. When '
  'Gmail and Outlook integration arrive they read this column to decide '
  'whether they are relevant to a given submission.';

create index submission_institution_idx
  on submission (institution_organisation_id)
  where institution_organisation_id is not null;

-- ---------------------------------------------------------------------------
-- Part 3 — who the file was addressed to
--
-- Multiple recipients are the norm, not an edge case: the relationship
-- manager, the credit manager who will actually query it, and the branch's
-- shared home-loans mailbox so it does not die when one person is on leave.
-- A single `bank_contact_id` on `submission` (0006) could hold exactly one of
-- those, so in practice the other two would have been typed into a note.
--
-- That older column is KEPT and untouched: it names the manager who OWNS the
-- file at the bank, which is a different question from who was on the address
-- line. Nothing is migrated off it.
--
-- Each row snapshots the same way `submission` does, and for the same reason.
-- `bank_contact_id` points at the catalogue entry it came from where there was
-- one — and is null when somebody typed an address that is not in the
-- catalogue, which must stay possible or people will keep a second list.
-- ---------------------------------------------------------------------------

create table submission_recipient (
  id              uuid primary key default gen_random_uuid(),
  submission_id   uuid not null references submission (id),

  -- Where this came from, when it came from anywhere. Nullable on purpose:
  -- a typed-in address is a legitimate recipient, and refusing it would push
  -- the real address list into a free-text note where nothing can read it.
  bank_contact_id uuid references bank_contact (id),

  -- The snapshot. Email is the only one required, because it is the only one
  -- without which the row means nothing.
  email           text not null,
  contact_name    text,
  designation     text,

  -- Was this the primary banker for the submission? Distinct from
  -- `bank_contact.is_primary_contact`, which is the branch's standing
  -- arrangement: this records who was actually addressed first on THIS file.
  is_primary      boolean not null default false,

  -- To or CC. Present because it is the one thing about a recipient that a
  -- future email integration cannot infer and the office genuinely knows —
  -- the branch mailbox is copied, the manager is addressed. Nothing sends
  -- mail today; this records the office's intent so that when something does,
  -- it is not guessing.
  recipient_kind  text not null default 'to',

  display_order   integer not null default 0,
  created_at      timestamptz not null default now(),
  created_by      uuid references app_user (id),

  constraint submission_recipient_kind_known
    check (recipient_kind in ('to', 'cc')),
  constraint submission_recipient_email_not_blank
    check (length(btrim(email)) > 0),
  -- Not full RFC validation, which no check constraint should attempt. This
  -- catches the mistakes that actually happen: a name typed into the email
  -- box, a missing domain, a trailing comma from a pasted list.
  constraint submission_recipient_email_shaped
    check (email ~ '^[^@[:space:],;]+@[^@[:space:],;]+\.[^@[:space:],;]+$')
);

comment on table submission_recipient is
  'The bankers one submission was addressed to. Multiple recipients are the '
  'norm — the relationship manager, the credit manager, and the branch''s '
  'shared mailbox — and a model holding one of them pushes the rest into a '
  'free-text note. Each row snapshots name, designation and email as they '
  'stood when the bank was added to the case, so that editing the catalogue '
  'never rewrites who a historical file was sent to (Milestone 10). '
  'NOTHING HERE SENDS EMAIL.';

comment on column submission_recipient.bank_contact_id is
  'The catalogue contact this recipient was taken from, where there was one. '
  'NULL for an address typed in on the spot, which must remain possible: a '
  'workflow that only accepts catalogued addresses is one people work around '
  'by keeping their own list.';

comment on column submission_recipient.email is
  'The address as it was at the time of submission. Snapshotted rather than '
  'read through `bank_contact_id` for the reason the whole of Part 2 exists: '
  'a manager moving on changes the catalogue and must not change history.';

comment on column submission_recipient.recipient_kind is
  'to / cc. Records the office''s intent about how this file is addressed. '
  'Read by nothing today. When Gmail or Outlook drafting arrives it consumes '
  'this rather than re-asking, which is the only reason the column exists '
  'now rather than then.';

create unique index submission_recipient_one_email_per_submission
  on submission_recipient (submission_id, lower(btrim(email)));

-- The same reasoning as bank_contact: a second primary is a mistake.
create unique index submission_recipient_one_primary
  on submission_recipient (submission_id)
  where is_primary;

create index submission_recipient_submission_idx
  on submission_recipient (submission_id);

create index submission_recipient_contact_idx
  on submission_recipient (bank_contact_id)
  where bank_contact_id is not null;

-- Row security, in the same shape 0021 used: the table is governed by its
-- parent submission (ADR-027's `case-derived` family), and shipping it
-- without RLS would make it the one readable back door into a case.
do $$
declare
  t text;
begin
  foreach t in array array[
    'submission_recipient'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- What this deliberately did NOT create, and where it attaches later
--
-- No `submission_package` table, no `submission_email` table, no attachment
-- manifest, no draft state. Each was considered and refused on ADR-028's
-- grounds: building the mapping table before there is anything to map
-- produces an empty table plus a screen nobody fills.
--
-- The seams are already here, and each is one migration away when the
-- milestone that needs it actually arrives:
--
--   Gmail / Outlook drafts  → read `submission_recipient` and
--                             `submission.submission_mode_id`; a draft id
--                             lands on `submission`.
--   Submission packages     → a package is a set of `document` rows chosen
--                             for one `submission`; that is a junction table
--                             against two tables that both already exist.
--   Submission history      → already recorded. Every status change writes an
--                             `event` (ADR-005), and `submission.status` plus
--                             `submitted_at` carry current truth.
--   Status tracking         → `app.submission_status` (0006) is unchanged and
--                             already independent per bank (ADR-004).
--
-- Email size splitting and OCR are not modelled at all and should not be
-- until the milestone that needs them states what it needs.
-- ---------------------------------------------------------------------------
