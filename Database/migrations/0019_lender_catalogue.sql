-- ===========================================================================
-- 0019 — Bank & NBFC Catalogue
--
-- Milestone 8. AOS's lender intelligence layer: not a list of banks, but a
-- model of how Amaze works with lending institutions.
--
-- The five concepts the milestone brief insists stay separate, and where each
-- one lives. Four of the five ALREADY EXISTED — this migration deepens them
-- rather than building a parallel set of tables beside them, because a second
-- "bank" entity next to `organisation` would break identity resolution
-- (ADR-014) the day someone typed "IIFL" twice:
--
--   Institution          organisation (role 'lender') + lender_profile
--        |               0003. Extended here.
--        v
--   Branch               organisation (role 'branch', parent = institution)
--        |               0003 + bank_branch, NEW here — the operational
--        |               facts a branch has and a generic organisation
--        v               does not (district, address, desk phone).
--   Relationship         bank_contact (person <-> branch)
--   Manager              0003. Extended here.
--        |
--        v
--   Supported Lending    bank_product (organisation <-> loan_product)
--   Products             0003. Extended here. NOT redefined: the product
--        |               definitions stay in the Lending Product Catalogue
--        v               (0015/0017) and this only says who offers what.
--   Submission Rules     lender_submission_rule, NEW here.
--                        DECLARATIVE ONLY — see the warning below.
--
-- Plus the sixth thing the milestone brief added, which does not fit in
-- fields at all:
--
--   Lender Profile       lender_insight, NEW here. The institutional
--                        knowledge an experienced loan team accumulates —
--                        "excellent for textile businesses", "often asks for
--                        an extra year of ITR", "the RM prefers WhatsApp
--                        before email". Structured enough to file and
--                        retrieve, deliberately NOT structured enough to
--                        execute.
--
-- ADDITIVE. No column is dropped, renamed or retyped. One nullability is
-- RELAXED (bank_contact.branch_organisation_id, so a regional manager who
-- belongs to no single branch can be recorded) — every existing row keeps its
-- value and every existing reader keeps seeing one.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO, each named in the brief as
-- "only create the foundation":
--
--   Eligibility engine. Nothing here decides whether a case will be
--   approved. The business-intelligence columns below are prose written by
--   staff FOR staff. ADR-016's warning is unchanged and is the reason
--   `known_strengths` is text and not a rule tree.
--
--   Submission workflow. `lender_submission_rule` records how a file is
--   lodged with a lender — counter, email, portal — as reference material.
--   It moves no case and creates no submission. `submission` (0006) is
--   untouched.
--
--   AI recommendation engine. `lender_insight` exists so that a future
--   assistant has honest context to quote. Context is not a decision, and
--   the distinction is the whole point of storing experience separately from
--   rules.
--
--   Document requirement engine. No lender -> document_type table here.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Part 1 — four more master-data vocabularies.
--
-- Same seven-column shape as every table created by 0012, for the same
-- reason: office staff learn it once, and a new lender type is an insert
-- rather than a deploy (ADR-030).
--
-- The first of them replaces an enum. `app.lender_type` (0001) has exactly
-- three values — bank, nbfc, hfc — and the milestone brief asks for seven
-- with room for more. A Small Finance Bank and a Regional Rural Bank are not
-- an engineering distinction; they are a business one, they change what a
-- case is worth routing there, and the list will keep growing. That is the
-- test ADR-030 set for enum-versus-table, and it fails as an enum.
--
-- The enum COLUMN stays and stays populated (see Part 2), the same
-- belt-and-braces 0015 used when `loan_product.category` became
-- `customer_product_id`: nothing reading `lender_profile.lender_type` breaks,
-- and the new column is what new code reads.
-- ---------------------------------------------------------------------------

create table lender_type (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  description    text,
  is_active      boolean not null default true,
  display_order  integer not null default 0,
  effective_from date,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid references app_user (id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references app_user (id),

  constraint lender_type_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table lender_type is
  'What kind of lending institution this is — Public Sector Bank, Private '
  'Sector Bank, Small Finance Bank, Regional Rural Bank, Cooperative Bank, '
  'NBFC, Housing Finance Company. RBI''s own categories, not Amaze''s '
  'invention. A table rather than the three-value `app.lender_type` enum it '
  'supersedes (ADR-030): the categories are a business distinction that '
  'changes where a case is worth sending, and the list grows — payments '
  'banks, fintech NBFCs, microfinance institutions — on a timescale of '
  'months. Milestone 8.';

create table lender_relationship_role (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  description    text,
  is_active      boolean not null default true,
  display_order  integer not null default 0,
  effective_from date,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid references app_user (id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references app_user (id),

  constraint lender_relationship_role_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table lender_relationship_role is
  'What a person at a lender does for Amaze — Relationship Manager, Branch '
  'Manager, Credit Manager, Sales Manager, Operations. Master data because '
  'every lender titles the same job differently and a new title must not '
  'need a migration. Replaces nothing: `bank_contact.designation` is free '
  'text and stays, holding the lender''s own wording verbatim, the same '
  'two-layer arrangement rejection reasons use (ADR-028). Milestone 8.';

create table submission_mode (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  description    text,
  is_active      boolean not null default true,
  display_order  integer not null default 0,
  effective_from date,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid references app_user (id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references app_user (id),

  constraint submission_mode_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table submission_mode is
  'HOW a file physically reaches a lender — over the branch counter, by '
  'email to a credit desk, through the lender''s own partner portal, or '
  'through a connector app. Reference material for the person doing the '
  'lodging. Does NOT drive the submission workflow, which is a later '
  'milestone and reads `submission` (0006), not this. Milestone 8.';

create table lender_insight_category (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  description    text,
  is_active      boolean not null default true,
  display_order  integer not null default 0,
  effective_from date,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid references app_user (id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references app_user (id),

  constraint lender_insight_category_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table lender_insight_category is
  'What kind of practical knowledge a lender insight is — a strength, a '
  'limitation, a documentation habit, a process tip, a communication '
  'preference, a segment the lender is good at, a pattern in its rejections. '
  'Categories exist so the notes can be grouped and later quoted back with '
  'their nature attached: "known limitation" reads differently to "process '
  'tip", and an assistant that loses that distinction will misuse both. '
  'Milestone 8.';

-- ---------------------------------------------------------------------------
-- Part 2 — the institution.
--
-- `organisation` already carries the name, the aliases, the city, the active
-- flag and the merge machinery (0003). `lender_profile` is its lender
-- extension, and it is where everything a lender has and a builder does not
-- belongs. Extending it is the whole of "for each institution" from the
-- brief, minus the two fields organisation already owns.
-- ---------------------------------------------------------------------------

alter table lender_profile
  add column lender_type_id             uuid references lender_type (id),
  add column code                       text,
  add column head_office_city           text,
  add column primary_service_region     text,
  add column website_url                text,

  -- Business intelligence. Informational, written by staff, read by staff.
  -- Deliberately prose: the moment "known limitations" becomes a structured
  -- rule set, somebody downstream will execute it, and executing an
  -- out-of-date rule is the failure ADR-016 exists to prevent.
  add column typical_turnaround_days    integer,
  add column preferred_customer_segments text,
  add column known_strengths            text,
  add column known_limitations          text,
  add column common_rejection_patterns  text,
  add column internal_remarks           text,

  add column display_order              integer not null default 0,
  add column updated_by                 uuid references app_user (id),

  add constraint lender_profile_code_shape
    check (code is null or code ~ '^[a-z][a-z0-9_]*$'),
  add constraint lender_profile_typical_turnaround_positive
    check (typical_turnaround_days is null or typical_turnaround_days > 0);

create unique index lender_profile_code_key on lender_profile (code) where code is not null;
create index lender_profile_type_idx on lender_profile (lender_type_id);

comment on column lender_profile.lender_type_id is
  'The master-data replacement for `lender_type` (the enum column). BOTH are '
  'kept and both are populated: the enum is what pre-Milestone-8 readers use '
  'and it can express bank / nbfc / hfc, while the new column can also '
  'express Small Finance Bank, Regional Rural Bank and Cooperative Bank. '
  'Where the finer category has no enum equivalent the enum holds the '
  'nearest true value — a Small Finance Bank and a Regional Rural Bank are '
  'both banks — which is a widening, never a lie.';

comment on column lender_profile.code is
  'A short, stable internal handle: sbi, hdfc_bank, bajaj_finance. Exists so '
  'reports, imports and AI prompts have something to key on that is not the '
  'display name, which changes when a lender rebrands or merges. Nullable '
  'because organisations created before this milestone have none.';

comment on column lender_profile.primary_service_region is
  'Where this lender actually lends, in the words staff use — "Tamil Nadu '
  'and Kerala", "Pan-India", "Coimbatore, Tiruppur, Erode". Free text on '
  'purpose: a lender''s real footprint is fuzzier than a district list, and '
  'forcing it into one would make the field precise and wrong.';

comment on column lender_profile.typical_turnaround_days is
  'How long this lender usually takes from lodging to sanction, in calendar '
  'days, as observed by the office. INFORMATIONAL. It is not an SLA, nothing '
  'escalates off it, and turnaround analytics — when they exist — will '
  'measure `submission` timestamps rather than trust this number. Kept '
  'alongside the older `standard_turnaround_days` rather than replacing it: '
  'that one is what the lender claims, this one is what the office sees.';

comment on column lender_profile.common_rejection_patterns is
  'Prose. What this lender tends to decline and why, as the team has '
  'experienced it. NOT `rejection_reason` (ADR-028), which is the '
  'standardised category recorded against an actual rejected submission and '
  'is the only thing reporting may count. This column is a warning to a '
  'human before lodging; that table is evidence after the fact.';

comment on column lender_profile.internal_remarks is
  'Anything the office needs to remember that has no other home. Never shown '
  'to a customer.';

-- ---------------------------------------------------------------------------
-- Part 3 — the branch.
--
-- A branch is already an organisation with the 'branch' role and a parent
-- (0003, ADR-015). What it did not have is anywhere to put the things you
-- actually need to reach it: which district it is in, its address, the desk
-- phone, whether it is even open. Those went nowhere, so in practice they
-- lived in somebody's phone.
--
-- An extension table rather than columns on `organisation`, matching
-- lender_profile and referrer_profile: an employer has no operational status
-- and no district manager, and six mostly-null columns on the shared table
-- is how a generic entity rots (ADR-014).
-- ---------------------------------------------------------------------------

create table bank_branch (
  organisation_id    uuid primary key references organisation (id),

  branch_code        text,
  city_id            uuid references city (id),
  district_id        uuid references district (id),
  address_line       text,
  contact_number     text,
  email              text,

  -- Three states, not a boolean, and the same reasoning ADR-033 used for
  -- product availability: "temporarily closed for renovation" and "this
  -- branch is gone" are different facts to the person deciding where to
  -- lodge a file tomorrow. Text with a check constraint rather than master
  -- data — a fixed operational state that code branches on, not a list a
  -- business user extends (ADR-030).
  operational_status text not null default 'operational',

  notes              text,
  display_order      integer not null default 0,
  created_at         timestamptz not null default now(),
  created_by         uuid references app_user (id),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references app_user (id),

  constraint bank_branch_status_known
    check (operational_status in ('operational', 'temporarily_closed', 'closed')),
  constraint bank_branch_code_not_blank
    check (branch_code is null or length(btrim(branch_code)) > 0)
);

comment on table bank_branch is
  'The operational facts about a lender''s branch: where it is, how to reach '
  'it, whether it is open. An extension on `organisation`, which already '
  'holds the branch''s name, its aliases and its parent institution (0003, '
  'ADR-015) — this adds only what a branch has that an employer or a builder '
  'does not. City and district are FKs into the master-data geography (0012, '
  '0014) rather than the free-text `organisation.city`, because "which '
  'branches are in Tiruppur district?" is a question the routing milestone '
  'will ask and free text cannot answer. Milestone 8.';

comment on column bank_branch.operational_status is
  'operational / temporarily_closed / closed. Distinct from '
  '`organisation.is_active`, which answers "should this appear in pickers at '
  'all?". A branch can be temporarily closed and still be the right branch '
  'for a file lodged next week.';

create index bank_branch_district_idx on bank_branch (district_id);
create index bank_branch_city_idx on bank_branch (city_id);
create index bank_branch_open_idx on bank_branch (organisation_id)
  where operational_status = 'operational';

-- ---------------------------------------------------------------------------
-- Part 4 — the relationship manager.
--
-- Already modelled, and modelled correctly: `bank_contact` is a person's
-- working relationship with a branch, precisely so that a manager moving
-- banks is a new row rather than a lost contact (0003). Nothing about that
-- changes. What it gains is the four things the brief lists that it could
-- not hold:
--
--   Role       — the master-data category, beside the lender's own job title
--   Mobile     — the WORK number, which is not the person's identity
--   Email      — likewise
--   Notes      — how this particular manager likes to be worked with
--
-- Why work mobile and email sit here and not on `person_identifier`: the
-- person's own phone is their identity and follows them for life; the desk
-- number and the bank email address belong to the posting and die with it.
-- Storing them as person identifiers would mean a manager who changes banks
-- keeps a dead @hdfcbank.com address on their identity record for ever, and
-- would quietly make a bank address a matching signal for a human being
-- (ADR-013).
-- ---------------------------------------------------------------------------

alter table bank_contact
  add column institution_organisation_id uuid references organisation (id),
  add column relationship_role_id        uuid references lender_relationship_role (id),
  add column work_mobile                 text,
  add column work_email                  text,
  add column notes                       text,
  add column is_active                   boolean not null default true,
  add column updated_by                  uuid references app_user (id);

-- Backfill before the constraint that requires it: every existing contact
-- belongs to a branch, and every branch names its institution (0003's
-- organisation_parent_is_branch_only constraint guarantees the parent is
-- there).
update bank_contact bc
set institution_organisation_id = b.parent_organisation_id
from organisation b
where b.id = bc.branch_organisation_id
  and bc.institution_organisation_id is null;

-- The one nullability RELAXED by this migration, and the reason: a regional
-- or state-level relationship manager belongs to the institution and to no
-- single branch. Every existing row keeps the branch it had — the backfill
-- above ran first — so no existing reader ever sees a null it did not see
-- before. The institution takes over as the required end of the relationship,
-- which is the truthful one: an RM always has an employer, not always a desk.
alter table bank_contact alter column branch_organisation_id drop not null;

update bank_contact set institution_organisation_id = branch_organisation_id
where institution_organisation_id is null;

alter table bank_contact
  alter column institution_organisation_id set not null,
  add constraint bank_contact_has_a_lender
    check (institution_organisation_id is not null);

comment on column bank_contact.institution_organisation_id is
  'Which lender this person works for. Required. The branch is optional '
  'because a regional or state-level manager belongs to no single branch — '
  'and a contact with an institution and no branch is a normal, useful '
  'record, not an incomplete one.';

comment on column bank_contact.work_mobile is
  'The number that reaches this person AT THIS POSTING. Deliberately not a '
  'person_identifier: identifiers are identity and follow a person for life, '
  'while a desk number dies with the posting (ADR-013).';

comment on column bank_contact.relationship_role_id is
  'The standardised role (lender_relationship_role). `designation` beside it '
  'keeps the lender''s own job title verbatim — the same two-layer '
  'arrangement as rejection reasons (ADR-028), and for the same reason: the '
  'category is what you group by, the verbatim text is what you quote.';

create index bank_contact_institution_idx on bank_contact (institution_organisation_id)
  where is_active;

-- ---------------------------------------------------------------------------
-- Part 5 — supported products.
--
-- `bank_product` has pointed at `loan_product` since 0003 and is exactly the
-- table the brief describes: "a branch or institution should indicate which
-- lending products it supports; do NOT duplicate product definitions". So
-- nothing is duplicated and no table is created — bank_product gains only
-- what it was missing to be usable as a catalogue entry.
-- ---------------------------------------------------------------------------

alter table bank_product
  add column notes          text,
  add column display_order  integer not null default 0,
  add column created_at     timestamptz not null default now(),
  add column created_by     uuid references app_user (id),
  add column updated_at     timestamptz not null default now(),
  add column updated_by     uuid references app_user (id);

comment on column bank_product.organisation_id is
  'The institution, OR one of its branches. Both are meaningful: most lenders '
  'offer a product everywhere, and recording that once against the '
  'institution is the honest representation; a branch row is for the case '
  'where one branch genuinely differs. Not enforced by a constraint because '
  'the role lives in an array on another table and a check constraint cannot '
  'reach it — the catalogue screen offers institutions and branches only.';

comment on column bank_product.name is
  'The LENDER''S own name for the product — "SBI Shaurya", "Bajaj Finserv '
  'Business Loan". Where the lender has no distinct brand name, or the office '
  'does not know it yet, the lending product''s own name is the correct '
  'entry: the row''s purpose is to record that this lender does this product, '
  'and a blank name would hide that fact rather than admit it.';

-- ---------------------------------------------------------------------------
-- Part 6 — submission rules. DECLARATIVE.
--
-- What the office needs to know before lodging a file with a lender: how it
-- goes in, where, what to carry, what usually comes back. Reference material
-- on a screen, in the same sense that a printed lender checklist pinned to a
-- wall is reference material.
--
-- It is a separate table and not columns on lender_profile because the brief
-- is explicit that submission rules are their own concept, and because they
-- genuinely vary two ways a single row cannot express: by branch (one branch
-- takes physical files, another insists on the portal) and by product (home
-- loans through the portal, business loans by email to the credit desk).
-- ---------------------------------------------------------------------------

create table lender_submission_rule (
  id                 uuid primary key default gen_random_uuid(),

  -- The institution, or one of its branches when that branch differs.
  organisation_id    uuid not null references organisation (id),

  -- Null means "for every product this lender does". A row naming a product
  -- is the exception that overrides it, which is how a person would write
  -- the note by hand.
  loan_product_id    uuid references loan_product (id),

  submission_mode_id uuid references submission_mode (id),
  portal_url         text,

  -- All prose, all guidance. See this migration's header.
  what_to_carry      text,
  login_fee_notes    text,
  turnaround_notes   text,
  notes              text,

  is_active          boolean not null default true,
  display_order      integer not null default 0,
  created_at         timestamptz not null default now(),
  created_by         uuid references app_user (id),
  updated_at         timestamptz not null default now(),
  updated_by         uuid references app_user (id)
);

comment on table lender_submission_rule is
  'How a file is lodged with this lender: over the counter, by email, through '
  'their portal — and what to have ready. REFERENCE MATERIAL, read by a '
  'person. It moves no case, creates no submission and blocks nothing; the '
  'submission workflow is a later milestone and works off `submission` '
  '(0006). Called a "rule" because that is what the office calls it, which '
  'is a warning worth writing down: nothing in AOS may ever execute it. '
  'Milestone 8.';

comment on column lender_submission_rule.loan_product_id is
  'Null means the rule covers every product this lender does. A row naming a '
  'product is a specific override, and the screen shows the specific one '
  'first — the way a person reads their own notes.';

create index lender_submission_rule_org_idx on lender_submission_rule (organisation_id)
  where is_active;
create index lender_submission_rule_product_idx on lender_submission_rule (loan_product_id)
  where loan_product_id is not null;

-- ---------------------------------------------------------------------------
-- Part 7 — the lender profile: institutional knowledge that does not fit in
-- fields.
--
-- "Excellent for textile businesses." "Responds quickly to MSME
-- manufacturing cases." "Very strict on GST compliance." "Often asks for an
-- extra year of ITR." "The RM prefers WhatsApp before email."
--
-- Every one of those is worth more than most columns in this schema, and not
-- one of them is a rule. They are what an experienced loan team knows and a
-- new joiner does not, and today they live in the heads of two people.
--
-- Stored as categorised free text, attached to an institution or a branch.
-- The category is what makes it retrievable; the free text is what makes it
-- honest. A future assistant may surface these as CONTEXT — "the team notes
-- that this lender is strict on GST compliance" — and must never treat one
-- as a condition it evaluated. That distinction between formal rules and
-- practical experience is the reason this is a separate table with its own
-- vocabulary rather than six more text columns on lender_profile.
-- ---------------------------------------------------------------------------

create table lender_insight (
  id                        uuid primary key default gen_random_uuid(),

  -- An institution or one of its branches. A branch-level insight is common
  -- and specific — one branch's credit manager is thorough, another's is not.
  organisation_id           uuid not null references organisation (id),

  lender_insight_category_id uuid not null references lender_insight_category (id),

  -- Optional narrowing. An insight about textile units under working capital
  -- is more useful filed against that product than against the whole lender.
  loan_product_id           uuid references loan_product (id),

  body                      text not null,

  -- Experience ages. A note from two years ago about a manager who has since
  -- transferred is worse than no note, so who said it and when is part of
  -- the record, not audit trivia.
  observed_on               date,

  is_active                 boolean not null default true,
  display_order             integer not null default 0,
  created_at                timestamptz not null default now(),
  created_by                uuid references app_user (id),
  updated_at                timestamptz not null default now(),
  updated_by                uuid references app_user (id),

  constraint lender_insight_body_not_blank check (length(btrim(body)) > 0)
);

comment on table lender_insight is
  'The lender profile: practical, accumulated knowledge about working with a '
  'lender, in the words of the person who learned it. GUIDANCE, NEVER A '
  'RULE. Nothing in AOS may branch on the content of `body`, and any future '
  'assistant must present these as what the team has observed rather than as '
  'a condition it checked — an insight is evidence about a lender, not a '
  'fact about a case. Kept separate from lender_profile''s columns precisely '
  'so that the line between formal criteria and lived experience stays '
  'visible in the schema and cannot be blurred by accident. Milestone 8.';

comment on column lender_insight.observed_on is
  'When this was true. A note about a manager who has since transferred is '
  'worse than no note, and a reader who can see the date can discount it.';

create index lender_insight_org_idx on lender_insight (organisation_id) where is_active;
create index lender_insight_category_idx on lender_insight (lender_insight_category_id);

-- ---------------------------------------------------------------------------
-- Part 8 — row level security and touch triggers, same as every other table
-- (0010, 0012). Governed by the permissions already bound in
-- src/domain/permissions/tables.ts: master_data.read / master_data.manage
-- for the vocabularies and the catalogue, organisation.read for what hangs
-- off an organisation. No new permission was needed, which is the intended
-- outcome of ADR-027 — a new domain should fit the existing model.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'lender_type', 'lender_relationship_role', 'submission_mode',
    'lender_insight_category', 'bank_branch', 'lender_submission_rule',
    'lender_insight'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create trigger %I_touch before update on %I for each row execute function app.touch_updated_at()',
      t, t
    );
  end loop;
end;
$$;

-- bank_product had no updated_at until this migration, so it had no trigger.
create trigger bank_product_touch before update on bank_product
  for each row execute function app.touch_updated_at();

-- ===========================================================================
-- Summary — what the lender layer now looks like, and what it still is not
--
-- It is: a configurable catalogue. Every list on it — lender type,
-- relationship role, submission mode, insight category, geography, lending
-- products — is a table someone at Amaze can add a row to. Adding a lender,
-- a branch, a manager, a supported product, a submission note or a piece of
-- hard-won experience is data entry. Nothing in this milestone requires code
-- to add a lender.
--
-- It is not: a decision-maker. Nothing here routes a case, scores a lender,
-- checks eligibility, generates a document list or submits anything. Case
-- Routing, Eligibility Suggestions, Submission Tracking, Turnaround
-- Analytics, AI Recommendations and Reporting all read this layer; none of
-- them is built by it, and each remains its own milestone.
-- ===========================================================================
