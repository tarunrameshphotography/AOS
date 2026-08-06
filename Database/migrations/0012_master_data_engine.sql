-- ===========================================================================
-- 0012 — Master Data Engine
--
-- Milestone 5. Turns the remaining hardcoded business vocabulary into
-- configurable master data, following the shape ADR-025 and ADR-028 already
-- established for loan_product, document_type and rejection_reason: a table
-- with code, name, description, is_active, display_order, notes — never an
-- enum, never a settings blob.
--
-- Every new table shares one shape deliberately, so office staff learn it
-- once:
--
--   code           text unique  — internal, stable, never shown to a customer
--   name           text         — what a human sees
--   description    text         — optional, explains the value to office staff
--   is_active      boolean      — deactivated, never deleted (matches every
--                                 other reference table in this schema)
--   display_order  integer      — controls list and dropdown order
--   effective_from date         — where a value has a real start date (a
--                                 constitution type or a city rarely does; the
--                                 column exists uniformly so a future value
--                                 that DOES need one is not a special case)
--   notes          text         — free text for office staff, not read by code
--
-- What did NOT become a table here, and why, is explained table by table below
-- and summarised at the end of this file.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- loan_category — the taxonomy loan_product.category has held as free text
-- since 0003. "Home Loan" / "Business Loan" / "LAP" / "Personal" is a small,
-- slow-changing list, but it is Amaze's own commercial grouping, not a
-- language concept, and a new one (e.g. a future "Gold Loan" business line)
-- should not need a migration. loan_product gains a nullable FK; the existing
-- `category` text column is untouched, so nothing that reads it breaks. Full
-- retirement of the text column, and the loan_product/bank_product management
-- screen itself, is the "Loan Product Catalogue" milestone, not this one.
-- ---------------------------------------------------------------------------

create table loan_category (
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

  constraint loan_category_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table loan_category is
  'Amaze''s own commercial grouping of loan products — Home Loan, Business '
  'Loan, LAP, Personal and whatever the business adds next. Master data, not '
  'an enum, on the same reasoning as document_type (ADR-025): the list changes '
  'on a business timescale, and adding a business line must not require a '
  'deploy. Milestone 5 (Master Data Engine).';

alter table loan_product add column loan_category_id uuid references loan_category (id);

comment on column loan_product.loan_category_id is
  'Replaces the free-text `category` column going forward. `category` is kept '
  'for backward compatibility (this migration is additive) and is expected to '
  'be retired once the Loan Product Catalogue milestone rebuilds this table''s '
  'management screen.';

-- ---------------------------------------------------------------------------
-- employment_type — was app.employment_type, an enum since 0001. Reclassified
-- here: 0001 drew the enum/table line at "changes on a timescale worth a code
-- review" versus "must absorb the outside world or requirement templates key
-- off it". Employment type fits the second description as much as
-- document_type does — a bank's classification of a customer's income source
-- (salaried / self-employed / business owner / retired / NRI / pensioner...)
-- is exactly the kind of list a lender panel change can extend without
-- anyone touching code. The enum stays, additively, so the domain layer's
-- existing `employment.employment_type` and any code branching on the three
-- known values keeps working; new code should read `employment_type_id`.
-- ---------------------------------------------------------------------------

create table employment_type (
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

  constraint employment_type_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table employment_type is
  'A person''s classification of income source — salaried, self-employed, '
  'business owner, and whatever a lender panel change adds next (retired, '
  'NRI, pensioner). Converted from app.employment_type (enum, 0001) to master '
  'data: it drives document-requirement generation exactly as document_type '
  'does, which is the ADR-025 test for "table, not enum". The enum column on '
  '`employment` is kept for backward compatibility. Milestone 5.';

alter table employment add column employment_type_id uuid references employment_type (id);

-- ---------------------------------------------------------------------------
-- business_constitution — new. Was not modelled at all: a borrowing firm
-- (ADR-009) had no field for how it is legally constituted, which a business
-- loan or LAP file needs (proprietorship vs partnership vs private limited
-- changes which documents a bank asks for). Master data because the list is
-- a fixed-but-extensible legal taxonomy, not a language concept.
-- ---------------------------------------------------------------------------

create table business_constitution (
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

  constraint business_constitution_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table business_constitution is
  'How a borrowing firm is legally constituted — proprietorship, partnership, '
  'private limited, LLP and so on. Not modelled before Milestone 5. Master '
  'data: legal categories a business-loan panel recognises are exactly the '
  'kind of vocabulary that changes without a code review reason to gate it.';

alter table organisation add column business_constitution_id uuid references business_constitution (id);

comment on column organisation.business_constitution_id is
  'Meaningful only for organisations holding the borrower role (ADR-014); '
  'null for employers, builders and banks. Not enforced by constraint — the '
  'same reasoning as roles being enforced by application logic elsewhere in '
  'this table.';

-- ---------------------------------------------------------------------------
-- property_type / property_ownership_type — property.property_type and
-- property.ownership_status have been free text since 0003, with no
-- structure at all: two office staff typing "Apartment" and "Flat" for the
-- same thing is exactly the duplicate-vocabulary problem master data exists
-- to prevent. Both become tables; both existing text columns are kept
-- (additive).
-- ---------------------------------------------------------------------------

create table property_type (
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

  constraint property_type_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table property_type is
  'What kind of property — apartment, independent house, plot, villa, '
  'commercial, agricultural. Was free text on `property` with no controlled '
  'vocabulary at all. Milestone 5.';

create table property_ownership_type (
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

  constraint property_ownership_type_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table property_ownership_type is
  'How title is held — freehold, leasehold, ancestral, power of attorney, '
  'joint ownership. Was free text on `property` with no controlled vocabulary '
  'at all. Milestone 5.';

alter table property add column property_type_id uuid references property_type (id);
alter table property add column property_ownership_type_id uuid references property_ownership_type (id);

-- ---------------------------------------------------------------------------
-- referral_source — loan_case.source has been free text since 0004, and the
-- prototype UI (Frontend/src/screens/NewCase.tsx) hardcoded its options as
-- literal <option> tags: "Phone enquiry", "Walk-in", "Referral", "Repeat
-- customer". That is precisely the hardcoded-dropdown-over-a-business-entity
-- pattern this milestone exists to remove — a new lead channel (a website
-- form, a social media campaign) could not be added without shipping code.
-- ---------------------------------------------------------------------------

create table referral_source (
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

  constraint referral_source_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table referral_source is
  'How a lead reached Amaze — phone enquiry, walk-in, referral, repeat '
  'customer, and whatever channel marketing adds next. Converts the hardcoded '
  '<option> list in the case-creation screen into master data (Milestone 5). '
  'The free-text `loan_case.source` column is kept for backward compatibility.';

alter table loan_case add column referral_source_id uuid references referral_source (id);

-- ---------------------------------------------------------------------------
-- district / city — new. Locality, city and pincode have been free text on
-- person, organisation and property since 0002/0003, and "the Madurai file"
-- is a real, load-bearing search (ADR-009's comment on property.locality).
-- These two tables give city and district a controlled vocabulary and a
-- structural relationship (a city belongs to a district) for the first time.
--
-- Deliberately NOT wired into person.city / organisation.city / property.city
-- in this migration: those three columns are free text on live-shaped tables
-- across the whole schema, and retrofitting them to a foreign key is exactly
-- the kind of change that wants its own migration and its own UI review
-- (matching existing text against the new master list, deciding what happens
-- to a locality typed once and never repeated) rather than being folded into
-- a milestone about establishing the master-data pattern itself. The tables
-- exist and are ready; wiring them into every consuming column is the
-- deliberately deferred remainder, noted at the end of this file.
-- ---------------------------------------------------------------------------

create table district (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  state          text,
  description    text,
  is_active      boolean not null default true,
  display_order  integer not null default 0,
  effective_from date,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid references app_user (id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references app_user (id),

  constraint district_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table district is
  'A district Amaze operates in or lends against, grouping cities. Master '
  'data: the operating footprint grows by business decision, not by code '
  'change. Milestone 5.';

create table city (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  district_id    uuid references district (id),
  description    text,
  is_active      boolean not null default true,
  display_order  integer not null default 0,
  effective_from date,
  notes          text,
  created_at     timestamptz not null default now(),
  created_by     uuid references app_user (id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references app_user (id),

  constraint city_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table city is
  'A city Amaze operates in or lends against. Master data for the same '
  'reason as district — the footprint is a business fact, not a code fact. '
  'Not yet referenced by person.city / organisation.city / property.city, '
  'which remain free text pending their own migration (see this file''s '
  'header comment). Milestone 5.';

create index city_district_idx on city (district_id);

-- ---------------------------------------------------------------------------
-- Row level security — deny by default, same as every other table (0010).
-- Governed by master_data.read / master_data.manage, the same permissions
-- that already govern loan_product, document_type and rejection_reason
-- (src/domain/permissions/tables.ts) — no new permission was needed.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'loan_category', 'employment_type', 'business_constitution',
    'property_type', 'property_ownership_type', 'referral_source',
    'district', 'city'
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

-- ===========================================================================
-- Summary — what became master data, and what deliberately did not
--
-- New or promoted to master data this migration: loan_category,
-- employment_type, business_constitution, property_type,
-- property_ownership_type, referral_source, district, city.
--
-- Already master data before this migration (ADR-025, ADR-028), unchanged
-- here: loan_product, bank_product, document_type, rejection_reason,
-- operational_threshold.
--
-- Already master data via the organisation model (ADR-014, ADR-015),
-- unchanged here: banks, NBFCs, HFCs (organisation rows with the `lender`
-- role, differentiated by lender_profile.lender_type) and branches
-- (organisation rows with the `branch` role). Their dedicated administration
-- screen is the "Coimbatore Bank & NBFC Catalogue" milestone; this migration
-- does not build one, only confirms the underlying data was already correct.
--
-- Deliberately kept as enums, not converted:
--   app.case_stage, app.progression_stage, app.submission_status,
--   app.requirement_status, app.lost_reason, app.case_party_role,
--   app.case_property_role, app.scope, app.role, app.identifier_type,
--   app.verification_source, app.alias_source, app.document_owner_kind,
--   app.communication_channel, app.communication_direction,
--   app.event_actor_kind, app.event_source, app.lender_type.
-- Every one of these is workflow or structural vocabulary Amaze owns and
-- that changing is a genuine code-and-review decision, not a data entry — a
-- new case stage or submission status changes the state machine in
-- src/domain/case and src/domain/requirements, not a dropdown. This is the
-- same line 0001 drew for lost_reason against rejection_reason (ADR-028) and
-- app.employment_type is the one place that line was previously drawn wrong,
-- corrected above.
-- ===========================================================================
