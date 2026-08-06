-- ===========================================================================
-- 0015 — Lending Product Catalogue
--
-- Milestone 7. Turns `loan_product` from a two-column taxonomy (category +
-- variant, free text, since 0003) into AOS's description of what Amaze
-- actually lends against — the layer the Document Requirement Engine, the
-- Eligibility Engine, the Bank Catalogue, workflow, reporting and AI
-- assistance will all read.
--
-- The three-level separation ADR-016 already implied, now explicit in the
-- schema:
--
--   loan_category   Amaze's commercial grouping        "Business Loan"
--        |          (master data since 0012)
--        v
--   loan_product    Amaze's bank-independent product   "Working Capital
--        |          — what THIS migration describes     Facility (CC)"
--        v
--   bank_product    one lender's version of it         "HDFC Smart Business
--                   (since 0003, unchanged here)        Loan"
--
-- Why the middle layer is the one that matters: it is known at case creation,
-- before any bank is chosen (ADR-016). A bank product cannot drive document
-- requirements because banks are selected late. A loan category is too coarse
-- — "Business Loan" does not tell you whether a property is involved. The
-- lending product is the finest-grained thing that is both known early and
-- stable enough to generate requirements from.
--
-- ADDITIVE. Every existing column keeps its name, type and nullability;
-- nothing that reads `loan_product.category` or `loan_product.variant` breaks.
-- Both are still populated for every row this catalogue creates (0016), so a
-- legacy reader sees a complete table. `name` is the display column going
-- forward and `loan_category_id` the grouping; the text pair is retired when
-- nothing reads it, which is not this milestone.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO — each named in the milestone
-- brief as "design so it fits later, do not implement":
--
--   Eligibility rules. The columns below are DECLARATIVE — they describe a
--   product, they do not decide a case. ADR-016's warning stands: a rules
--   engine that confidently returns a wrong answer is worse than none. A
--   future engine reads these columns; it is not created by them.
--
--   Bank-specific products. `bank_product` already exists and already points
--   at `loan_product`. It gains nothing here beyond the hierarchy above being
--   real. Its own screen is the Bank & NBFC Catalogue milestone.
--
--   Document requirement templates. There is no loan_product ->
--   document_type table here. Requirement generation still branches on
--   product code in the domain layer; making it data is the Document
--   Requirement Engine milestone, and it will hang off this table.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Three new master-data tables, same shape as every other one (0012):
-- code / name / description / is_active / display_order / effective_from /
-- notes. Office staff learn the shape once.
--
-- Why these three and not more: the milestone brief lists Borrower Type,
-- Security Type, Employment Eligibility, Business Eligibility, Property
-- Requirement and GST Requirement as product attributes. Employment and
-- business eligibility REUSE the existing `employment_type` and
-- `business_constitution` tables rather than duplicating them — that reuse is
-- the point of having had a Master Data Engine milestone first. Property and
-- GST requirement share ONE table, `requirement_applicability`, because they
-- ask the same question ("must this product have it?") and two identical
-- three-row tables would be two places to get the same answer wrong.
-- ---------------------------------------------------------------------------

create table borrower_type (
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

  constraint borrower_type_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table borrower_type is
  'WHO may borrow under a lending product — a resident individual, an NRI '
  'individual, or a non-individual entity. Deliberately NOT a duplicate of '
  '`business_constitution`: that answers "how is the firm legally '
  'constituted?" (proprietorship / partnership / private limited) and is '
  'reused as-is for a product''s business eligibility. This answers the '
  'coarser question a product asks first — is the borrower a person or a '
  'firm, and does residency change the product? An NRI Home Loan and a '
  'resident Home Loan are different products with different documents, which '
  'is exactly why residency belongs here. Milestone 7.';

create table security_type (
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

  constraint security_type_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table security_type is
  'What secures a lending product — nothing (clean/unsecured), a mortgage '
  'over immovable property, pledged gold, hypothecated stock and book debts, '
  'a hypothecated vehicle, pledged financial securities, or a third-party or '
  'institutional guarantee. RBI and lender terminology, not Amaze''s '
  'invention. Master data because the list grows with the products Amaze '
  'sources, not with the code. Milestone 7.';

create table requirement_applicability (
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

  constraint requirement_applicability_code_shape check (code ~ '^[a-z][a-z0-9_]*$')
);

comment on table requirement_applicability is
  'How strongly a lending product requires something — mandatory, optional, '
  'or not applicable. One shared vocabulary used by both '
  'loan_product.property_requirement_id and loan_product.gst_requirement_id, '
  'because they ask the same question about different things. A table rather '
  'than an enum for the ordinary ADR-025 reason and one specific to it: a '
  'lender panel that starts distinguishing "mandatory unless waived" adds a '
  'row, not a migration. Milestone 7.';

-- ---------------------------------------------------------------------------
-- loan_product — the catalogue itself.
--
-- Every column below is one line of the milestone brief's product design,
-- with the two it already had (Product Code = `code`, Active/Inactive =
-- `is_active`) untouched.
-- ---------------------------------------------------------------------------

alter table loan_product add column name        text;
alter table loan_product add column description text;

comment on column loan_product.name is
  'The product''s own name, as office staff say it — "Working Capital '
  'Facility (CC)", "Lease Rental Discounting". Replaces the (category, '
  'variant) text pair as the display column. Both text columns are still '
  'populated (this migration is additive and 0016 fills them) so nothing '
  'reading them breaks; they are retired when nothing does.';

alter table loan_product
  add column security_type_id uuid references security_type (id);

comment on column loan_product.security_type_id is
  'The PRIMARY security. A product with more than one (a term loan secured '
  'by machinery AND a CGTMSE guarantee) records the principal one here; a '
  'loan_product_security_type junction is the natural extension if that '
  'becomes common, and nothing here forecloses it.';

alter table loan_product
  add column property_requirement_id uuid references requirement_applicability (id);
alter table loan_product
  add column gst_requirement_id      uuid references requirement_applicability (id);

comment on column loan_product.property_requirement_id is
  'Whether this product needs a property at all. The single most useful '
  'field on this table for the Document Requirement Engine: no property, no '
  'sale deed, no encumbrance certificate, no valuation report.';

comment on column loan_product.gst_requirement_id is
  'Whether GST registration is expected of the borrowing business. Drives '
  'whether GST certificate and GST returns are asked for, and is the field '
  'that separates a formal-sector business loan from a small-trader one.';

alter table loan_product add column min_tenure_months integer;
alter table loan_product add column max_tenure_months integer;
alter table loan_product add column min_amount        numeric(14, 2);
alter table loan_product add column max_amount        numeric(14, 2);

alter table loan_product add constraint loan_product_tenure_ordered
  check (min_tenure_months is null or max_tenure_months is null
         or max_tenure_months >= min_tenure_months);
alter table loan_product add constraint loan_product_tenure_positive
  check ((min_tenure_months is null or min_tenure_months > 0)
         and (max_tenure_months is null or max_tenure_months > 0));
alter table loan_product add constraint loan_product_amounts_ordered
  check (min_amount is null or max_amount is null or max_amount >= min_amount);

comment on column loan_product.min_tenure_months is
  'TYPICAL, not contractual. The market range across the lenders Amaze deals '
  'with, so an office user is warned when a customer asks for something no '
  'lender on the panel offers. The binding numbers are per lender and live '
  'on bank_product (ADR-016) — this column must never be read as a rule.';

-- ---------------------------------------------------------------------------
-- Lifecycle — revision and retirement, designed for now, not implemented.
--
-- A lending product is never edited into a different product and never
-- deleted (NEVER_DELETED, as everywhere else in this schema). Two ways it
-- changes, both expressible with the columns below and neither needing a
-- migration:
--
--   Retirement — set is_active = false, and effective_to to the last date it
--   was offered. Cases already carrying it keep working, which a delete
--   would break.
--
--   Revision — insert the new version as a new row with its own code, point
--   supersedes_loan_product_id at the old one, and retire the old one. The
--   chain is then walkable in both directions, which is what reporting needs
--   when it asks "how did this product perform across its revisions?".
--
-- Neither flow is built in this milestone. The columns exist so that
-- building it later is application code over an unchanged schema.
-- ---------------------------------------------------------------------------

alter table loan_product add column effective_from date;
alter table loan_product add column effective_to   date;
alter table loan_product
  add column supersedes_loan_product_id uuid references loan_product (id);
alter table loan_product add column notes text;

alter table loan_product add constraint loan_product_effective_ordered
  check (effective_from is null or effective_to is null or effective_to >= effective_from);
alter table loan_product add constraint loan_product_does_not_supersede_itself
  check (supersedes_loan_product_id is null or supersedes_loan_product_id <> id);

comment on column loan_product.supersedes_loan_product_id is
  'The earlier product this one replaces, when a product is revised rather '
  'than edited. Null for an original. Milestone 7 creates no revisions — the '
  'column exists so that the first one is data entry, not a migration.';

-- Audit columns, which loan_product has lacked since 0003 while every other
-- master-data table has carried them since 0012. A catalogue office staff
-- edit needs to say who changed it.
alter table loan_product add column created_at timestamptz not null default now();
alter table loan_product add column created_by uuid references app_user (id);
alter table loan_product add column updated_at timestamptz not null default now();
alter table loan_product add column updated_by uuid references app_user (id);

create index loan_product_category_idx on loan_product (loan_category_id) where is_active;

-- ---------------------------------------------------------------------------
-- Eligibility, as junctions rather than columns.
--
-- Borrower type, employment eligibility and business eligibility are all
-- many-to-many: a Loan Against Property is available to a salaried employee
-- AND a self-employed professional AND a business owner. A column would
-- force one, and a comma-separated text column would force the reader to
-- parse it — which is how you end up with vocabulary drift the Master Data
-- Engine milestone existed to remove.
--
-- Junction rows are DELETED when eligibility is edited, unlike every other
-- table in this schema. They carry no history of their own: the fact of
-- record is the product, and the event log (ADR-005) records the edit. A
-- soft-deleted junction row would make every consuming query filter on it
-- forever for no reader's benefit.
-- ---------------------------------------------------------------------------

create table loan_product_borrower_type (
  loan_product_id  uuid not null references loan_product (id) on delete cascade,
  borrower_type_id uuid not null references borrower_type (id),
  created_at       timestamptz not null default now(),
  created_by       uuid references app_user (id),

  primary key (loan_product_id, borrower_type_id)
);

comment on table loan_product_borrower_type is
  'Which kinds of borrower a lending product is available to. Many-to-many: '
  'most products serve resident individuals, some also serve NRIs, business '
  'products serve non-individual entities too. Milestone 7.';

create table loan_product_employment_type (
  loan_product_id    uuid not null references loan_product (id) on delete cascade,
  employment_type_id uuid not null references employment_type (id),
  created_at         timestamptz not null default now(),
  created_by         uuid references app_user (id),

  primary key (loan_product_id, employment_type_id)
);

comment on table loan_product_employment_type is
  'Which income-source classifications a lending product accepts, reusing '
  'the `employment_type` master data added in 0012 rather than inventing a '
  'second vocabulary for the same idea. This is the join the Document '
  'Requirement Engine will read to decide between payslips and ITR without '
  'branching on a product code in TypeScript. Milestone 7.';

create table loan_product_business_constitution (
  loan_product_id          uuid not null references loan_product (id) on delete cascade,
  business_constitution_id uuid not null references business_constitution (id),
  created_at               timestamptz not null default now(),
  created_by               uuid references app_user (id),

  primary key (loan_product_id, business_constitution_id)
);

comment on table loan_product_business_constitution is
  'Which legal constitutions of a borrowing firm a lending product accepts, '
  'reusing the `business_constitution` master data added in 0012. Empty for '
  'a product no firm can take (a salaried personal loan), which is a '
  'meaningful state and not a missing row. Milestone 7.';

create index loan_product_employment_type_employment_idx
  on loan_product_employment_type (employment_type_id);
create index loan_product_business_constitution_constitution_idx
  on loan_product_business_constitution (business_constitution_id);

-- ---------------------------------------------------------------------------
-- Row level security — deny by default, as 0010 established for every table.
-- Governed by master_data.read / master_data.manage, which already govern
-- loan_product itself (src/domain/permissions/tables.ts). No new permission
-- was needed, and inventing a `product.manage` would split the catalogue's
-- governance from the vocabulary it is built out of.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'borrower_type', 'security_type', 'requirement_applicability',
    'loan_product_borrower_type', 'loan_product_employment_type',
    'loan_product_business_constitution'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end;
$$;

-- Touch triggers, for the tables that carry updated_at. The junctions do not:
-- a junction row is created or removed, never amended.
create trigger borrower_type_touch before update on borrower_type
  for each row execute function app.touch_updated_at();
create trigger security_type_touch before update on security_type
  for each row execute function app.touch_updated_at();
create trigger requirement_applicability_touch before update on requirement_applicability
  for each row execute function app.touch_updated_at();
create trigger loan_product_touch before update on loan_product
  for each row execute function app.touch_updated_at();
