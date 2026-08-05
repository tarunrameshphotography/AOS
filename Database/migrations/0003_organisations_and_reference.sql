-- ===========================================================================
-- 0003 — Organisations, reference data, and properties
--
-- Every non-human party is one table (ADR-014). Banks and branches are
-- organisations, which is the non-obvious part and the part that pays: "IIFL" /
-- "IIFL Home Finance Ltd" / "India Infoline" is the same alias-and-dedup problem
-- as "ABC Textiles", and treating lenders as organisations means alias, fuzzy
-- match, merge and tombstone-redirect all apply to banks without building any of
-- it twice.
--
-- Vocabulary rule: the word "Organisation" never appears in the interface. Users
-- see Bank, Branch, Builder, Employer. The generic model is a schema fact and
-- stays here (Principle #3).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- organisation
-- ---------------------------------------------------------------------------
create table organisation (
  id                     uuid primary key default gen_random_uuid(),
  canonical_name         text not null,

  -- Flags, not tables: roles overlap constantly. A construction firm is a
  -- builder on one case, a vendor on another, and somebody's employer on a
  -- third. Separate tables would store that firm three times (ADR-014).
  roles                  app.organisation_role[] not null default '{}',

  industry               text,
  city                   text,

  -- Exists for exactly one purpose: branch -> bank (ADR-015). General
  -- hierarchies, parent companies and groups are out of scope for V1 and this
  -- column must not be quietly repurposed. A submission physically goes to a
  -- branch and a relationship manager belongs to one; that is the operational
  -- justification, not branch-level statistics, which would be noise at ten
  -- cases a month.
  parent_organisation_id uuid references organisation (id),

  merged_into_id         uuid references organisation (id),
  merged_at              timestamptz,

  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  created_by             uuid references app_user (id),
  updated_at             timestamptz not null default now(),

  constraint organisation_name_not_blank check (length(btrim(canonical_name)) > 0),
  constraint organisation_roles_not_empty check (cardinality(roles) > 0),
  constraint organisation_merge_is_complete check ((merged_into_id is null) = (merged_at is null)),
  constraint organisation_merge_is_not_self check (merged_into_id is null or merged_into_id <> id),
  constraint organisation_is_not_own_parent check (parent_organisation_id is null or parent_organisation_id <> id),
  -- Only a branch has a parent, and a branch must have one. Anything else is
  -- the general hierarchy this column exists to avoid.
  constraint organisation_parent_is_branch_only
    check ((parent_organisation_id is not null) = ('branch' = any (roles)))
);

comment on table organisation is
  'Every non-human party: employers, borrowing firms, builders, developers, '
  'vendors, banks and branches. One identity model with roles attached, matching '
  'the shape used for people (ADR-006, ADR-014, ADR-015). Required because for '
  'business loans and LAP the borrower may itself be a firm, holding its own GST '
  'certificate, ITR and financials (ADR-009). Follows BR-003 to BR-005 '
  'identically to person (BR-006). PRD/Data Model.md, '
  'PRD/Identity Resolution.md Part 4.';

comment on column organisation.roles is
  'Multiple allowed. Every list view must filter by role or it will show banks '
  'in the employer picker.';

create index organisation_roles_idx on organisation using gin (roles);
create index organisation_name_trgm_idx on organisation using gin (canonical_name gin_trgm_ops);
create index organisation_parent_idx on organisation (parent_organisation_id)
  where parent_organisation_id is not null;

-- ---------------------------------------------------------------------------
-- organisation_alias
-- ---------------------------------------------------------------------------
create table organisation_alias (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisation (id),
  alias           text not null,

  -- Legal suffixes stripped and case folded, so "ABC Textiles" and "ABC
  -- Textiles Pvt Ltd" collide as intended.
  alias_normalised text not null,

  source          app.alias_source not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references app_user (id),

  constraint organisation_alias_not_blank check (length(btrim(alias)) > 0)
);

comment on table organisation_alias is
  'Alternative names. Near-matches surface as suggestions and are never '
  'auto-merged — "Sri Lakshmi Traders" and "Sri Lakshmi Textiles" are plausibly '
  'different businesses, and only a human knows (Principle #7). '
  'PRD/Identity Resolution.md Part 4.';

create index organisation_alias_org_idx on organisation_alias (organisation_id);
create index organisation_alias_trgm_idx on organisation_alias using gin (alias_normalised gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- lender_profile
-- ---------------------------------------------------------------------------
create table lender_profile (
  organisation_id   uuid primary key references organisation (id),
  lender_type       app.lender_type not null,
  is_on_panel       boolean not null default true,
  standard_turnaround_days integer,
  notes             text,
  created_at        timestamptz not null default now(),
  created_by        uuid references app_user (id),
  updated_at        timestamptz not null default now(),

  constraint lender_profile_turnaround_positive
    check (standard_turnaround_days is null or standard_turnaround_days > 0)
);

comment on table lender_profile is
  'Bank-specific operational facts. An extension table on organisation, '
  'mirroring referrer_profile on person — specialisation lives in extensions, '
  'not in a separate entity (ADR-014). PRD/Data Model.md.';

-- ---------------------------------------------------------------------------
-- bank_contact
-- ---------------------------------------------------------------------------
create table bank_contact (
  id                     uuid primary key default gen_random_uuid(),
  person_id              uuid not null references person (id),
  branch_organisation_id uuid not null references organisation (id),
  designation            text,
  active_from            date not null default current_date,
  active_to              date,
  created_at             timestamptz not null default now(),
  created_by             uuid references app_user (id),
  updated_at             timestamptz not null default now(),

  constraint bank_contact_period_ordered
    check (active_to is null or active_to >= active_from)
);

comment on table bank_contact is
  'A person''s working relationship with a bank branch. Modelled as a '
  'relationship precisely so that a manager moving banks — or moving branches '
  'within a bank, which is more common — is one new row, not a lost contact. '
  'Deliberately NOT a case_party role: a bank contact belongs to a branch and is '
  'referenced by the submission that person is working, and putting them on the '
  'case as well would be two representations of one fact (audit finding B2). '
  'PRD/Data Model.md.';

create index bank_contact_branch_idx on bank_contact (branch_organisation_id) where active_to is null;
create index bank_contact_person_idx on bank_contact (person_id);

-- ---------------------------------------------------------------------------
-- employment
-- ---------------------------------------------------------------------------
create table employment (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references person (id),
  organisation_id uuid not null references organisation (id),
  designation     text,
  monthly_income  numeric(14, 2),
  employment_type app.employment_type not null,
  start_date      date,
  end_date        date,
  is_current      boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      uuid references app_user (id),
  updated_at      timestamptz not null default now(),

  constraint employment_period_ordered check (end_date is null or start_date is null or end_date >= start_date),
  constraint employment_current_has_no_end check (not is_current or end_date is null),
  constraint employment_income_not_negative check (monthly_income is null or monthly_income >= 0)
);

comment on table employment is
  'A person''s employer and employment type. Employment type drives requirement '
  'generation (ADR-011), which is why this is a modelled relationship rather '
  'than a field on person — it changes, and the history matters when a bank asks '
  'about job stability. Referenced twice in the PRD but never defined until the '
  'consistency audit found it (finding C1). PRD/Data Model.md.';

create index employment_person_idx on employment (person_id) where is_current;
create index employment_organisation_idx on employment (organisation_id);

-- ---------------------------------------------------------------------------
-- property
-- ---------------------------------------------------------------------------
create table property (
  id                        uuid primary key default gen_random_uuid(),

  -- None of these is mandatory. Property has no reliable natural key: the same
  -- flat is "Flat 3B, Green Meadows, Anna Nagar" to the customer, a survey
  -- number on the sale deed, and a different door number after municipal
  -- renumbering (PRD/Identity Resolution.md Part 5).
  door_number               text,
  building_name             text,

  -- The field to fight for. "The Madurai file" is how people actually search,
  -- so locality is structured and autocompleted, never buried in an address
  -- blob.
  locality                  text,
  city                      text,
  pincode                   text,

  property_type             text,
  area_sqft                 numeric(12, 2),
  estimated_value           numeric(14, 2),
  ownership_status          text,
  survey_number             text,
  registration_number       text,

  merged_into_id            uuid references property (id),
  merged_at                 timestamptz,

  created_at                timestamptz not null default now(),
  created_by                uuid references app_user (id),
  updated_at                timestamptz not null default now(),

  constraint property_merge_is_complete check ((merged_into_id is null) = (merged_at is null)),
  constraint property_merge_is_not_self check (merged_into_id is null or merged_into_id <> id),
  constraint property_area_positive check (area_sqft is null or area_sqft > 0),
  constraint property_value_not_negative check (estimated_value is null or estimated_value >= 0)
);

comment on table property is
  'Collateral, or the property being purchased. Owned independently of any case: '
  'the same property appears in a purchase, a later top-up and a balance '
  'transfer (ADR-007). Properties are never auto-merged — the financial '
  'consequence of wrongly linking two properties is far worse than a duplicate '
  'row, and duplicates are tolerable because properties are found through their '
  'case and their people, which are well identified. '
  'PRD/Identity Resolution.md Part 5.';

comment on column property.locality is
  'Structured and autocompleted, not free text. "The Madurai file" is a real '
  'search.';

create index property_locality_idx on property (locality) where locality is not null;
create index property_survey_idx on property (survey_number) where survey_number is not null;
create index property_registration_idx on property (registration_number) where registration_number is not null;
create index property_building_trgm_idx on property using gin (building_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Reference data — ADR-025's three mechanisms, none of them a settings module
-- ---------------------------------------------------------------------------

create table loan_product (
  id         uuid primary key default gen_random_uuid(),
  category   text not null,
  variant    text not null,
  code       text not null unique,
  is_active  boolean not null default true,
  display_order integer not null default 0,

  unique (category, variant)
);

comment on table loan_product is
  'Amaze''s own taxonomy, independent of any bank. Critically it is known AT '
  'CASE CREATION, before any bank is chosen — which is what makes the '
  'requirement engine possible, since banks are selected late and a '
  'bank-specific product therefore cannot drive requirements (ADR-016). Drives '
  'document requirements, workflow shape, and reporting by business line. '
  'PRD/Data Model.md.';

create table bank_product (
  id              uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisation (id),
  loan_product_id uuid not null references loan_product (id),
  name            text not null,
  min_amount      numeric(14, 2),
  max_amount      numeric(14, 2),
  indicative_rate numeric(5, 2),
  is_active       boolean not null default true,

  constraint bank_product_amounts_ordered
    check (min_amount is null or max_amount is null or max_amount >= min_amount)
);

comment on table bank_product is
  'A specific lender''s offering, mapped to a loan_product. Drives submission '
  'rules and bounds. Deliberately declarative and NOT an executable eligibility '
  'rules engine: bank criteria change without notice, and an out-of-date engine '
  'that confidently returns a wrong answer is worse than no engine (ADR-016). '
  'PRD/Data Model.md.';

create index bank_product_organisation_idx on bank_product (organisation_id) where is_active;
create index bank_product_loan_product_idx on bank_product (loan_product_id);

create table document_type (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  description   text,

  -- What kind of thing this document can belong to. Stops a payslip being
  -- attached to a property.
  owner_kind    app.document_owner_kind not null,

  requires_period boolean not null default false,
  requires_expiry boolean not null default false,
  is_active     boolean not null default true,
  display_order integer not null default 0
);

comment on table document_type is
  'The kinds of document AOS recognises. A TABLE rather than an enum because '
  'requirement templates key off it and adding a document type must not be a '
  'migration (ADR-025). Referenced by document and document_requirement, and '
  'named in master_data.manage, but had no entity block until the settings '
  'review. PRD/Data Model.md.';

comment on column document_type.requires_period is
  'True for statements and ITR, where "which months?" is part of the identity of '
  'the document.';

create table operational_threshold (
  key         text primary key,
  value_days  integer not null,
  description text not null,
  updated_by  uuid references app_user (id),
  updated_at  timestamptz not null default now(),

  constraint operational_threshold_positive check (value_days > 0)
);

comment on table operational_threshold is
  'The one narrow table for tunable timings — idle threshold per stage, '
  'offer-expiry warning lead time, unverified-document age, default hold '
  'follow-up. The KEYS are a closed enum in src/domain/settings/thresholds.ts, '
  'seeded by migration; the VALUE is editable at runtime, the key set is not. '
  'That asymmetry is the entire design: it is the same pattern as the permission '
  'catalog, and it is the difference between a lookup table and a configuration '
  'system. AOS has no settings module and no key-value config table (ADR-025).';

create table rejection_reason (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name          text not null,
  description   text,
  is_active     boolean not null default true,
  display_order integer not null default 0,

  constraint rejection_reason_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table rejection_reason is
  'Amaze''s standardised rejection categories. Master data, not an enum: new '
  'lenders arrive with new vocabulary on a timescale of weeks, and if adding a '
  'category needs a migration people will pick the nearest wrong value instead — '
  'silently corrupting the one dataset this table exists to protect (ADR-028). '
  'Required by BR-024 and BR-027. The bank''s own wording is recorded verbatim '
  'on the submission and never substitutes for the category (BR-026), which is '
  'what makes rejections comparable across banks that describe the same refusal '
  'differently. PRD/Business Rules.md, PRD/Data Model.md.';

comment on column rejection_reason.is_active is
  'Retired categories are deactivated, never deleted, so historic submissions '
  'keep pointing at the category they were classified under (BR-027).';

create trigger organisation_touch     before update on organisation     for each row execute function app.touch_updated_at();
create trigger lender_profile_touch   before update on lender_profile   for each row execute function app.touch_updated_at();
create trigger bank_contact_touch     before update on bank_contact     for each row execute function app.touch_updated_at();
create trigger employment_touch       before update on employment       for each row execute function app.touch_updated_at();
create trigger property_touch         before update on property         for each row execute function app.touch_updated_at();
create trigger operational_threshold_touch before update on operational_threshold for each row execute function app.touch_updated_at();
