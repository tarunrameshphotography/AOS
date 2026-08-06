-- ===========================================================================
-- 0021 — Document Requirement Engine
--
-- Milestone 9. Turns "which documents does this case need?" from an `if`
-- statement in the requirement generator into rows a business user can edit.
--
-- 0015's header named this migration in advance:
--
--     "There is no loan_product -> document_type table here. Requirement
--      generation still branches on product code in the domain layer; making
--      it data is the Document Requirement Engine milestone, and it will hang
--      off this table."
--
-- This is that table. It deliberately does NOT hang off loan_product with a
-- foreign key, and the reason matters: a rule is not "a document this product
-- needs". It is "a document this SITUATION needs", and the situation is a
-- conjunction — product AND employment type AND constitution AND whether a
-- property exists AND whether GST applies. A two-column junction table
-- (loan_product, document_type) can express none of that, and every system
-- that starts with one ends up with a `notes` column full of conditions
-- nobody can query.
--
-- THE SHAPE
--
--   document_requirement_rule            one rule: "ask for X, of Y, from stage Z"
--     -> document_requirement_rule_condition   zero or more: "...when this fact holds"
--
-- A rule with NO conditions is unconditional (PAN, for every individual who
-- signs). A rule with three conditions fires when all three hold — or when
-- any one does, if `condition_match` says so.
--
-- WHAT IS NOT HERE, deliberately:
--
--   Eligibility. A rule decides what to ASK FOR. It never decides whether a
--   case is approvable. ADR-016's warning stands (ADR-035 restates it).
--
--   OCR. Nothing here reads a document; it only records that one is wanted.
--
--   Lender-specific checklists. These rules describe Amaze's own
--   file-completeness standard. A lender's own additional asks belong on
--   lender_submission_rule (0019), which is reference material for a human.
--
-- ADDITIVE. Every existing column keeps its name, type and nullability.
-- document_requirement gains two nullable columns and nothing else changes;
-- rows generated before this migration remain valid and readable.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------

-- 'rejected' completes the requirement lifecycle the milestone brief asks for:
-- Applicable / Not Applicable / Waived / Pending / Received / Verified /
-- Rejected. Until now a rejected upload sent the requirement back to
-- 'pending', which loses the fact that a human already spent time on it and
-- told the customer why. Mirrors src/domain/requirements/progress.ts.
--
-- Postgres 12+ allows adding an enum value without rewriting the type. It
-- cannot be done inside a transaction block in older versions, hence its
-- position at the top of this file rather than buried mid-migration.
alter type app.requirement_status add value if not exists 'rejected' after 'verified';

create type app.rule_scope as enum ('case', 'party', 'property');

comment on type app.rule_scope is
  'What a rule attaches its requirement to. A party-scoped rule is evaluated '
  'once per party who actually exists, which is how "absence is silence" '
  '(ADR-010, BR-033) falls out of the design rather than being enforced by a '
  'check: a case with no guarantor never enters the guarantor branch at all.';

create type app.rule_condition_operator as enum (
  'equals',
  'not_equals',
  'in',
  'not_in',
  'is_true',
  'is_false',
  'exists',
  'absent',
  'gte',
  'lte'
);

comment on type app.rule_condition_operator is
  'Mirrors CONDITION_OPERATORS in src/domain/requirements/rules.ts, which is '
  'authoritative. is_false means EXPLICITLY false, never merely unknown — '
  '"the business said it is not GST registered" and "nobody has been asked '
  'yet" are different facts, and a rule that conflates them fires on every '
  'half-filled case.';

create type app.construction_stage as enum (
  'not_started',
  'foundation',
  'plinth',
  'walls',
  'roofing',
  'finishing',
  'completed'
);

comment on type app.construction_stage is
  'How far a funded construction has got. Null on every product that does not '
  'fund building work — a plot purchase has no construction stage, and '
  'defaulting one in would make "requirements appear only when applicable" '
  'quietly untrue.';

-- ---------------------------------------------------------------------------
-- document_requirement_rule
-- ---------------------------------------------------------------------------
create table document_requirement_rule (
  id                    uuid primary key default gen_random_uuid(),

  -- Stable handle, the same convention every master-data table uses since
  -- 0012. Referenced by generated requirements so "why is this being asked
  -- for?" survives the rule later being edited.
  code                  text not null unique,
  name                  text not null,

  document_type_id      uuid not null references document_type (id),

  scope                 app.rule_scope not null,

  -- For scope = 'party'. Null or empty means every role EXCEPT referrer, who
  -- is on the case for attribution and is applying for nothing. An array
  -- rather than a junction table: the list is short, closed (case_party_role
  -- is an enum) and always read whole.
  party_roles           app.case_party_role[],
  -- Restrict to people or to organisations, so a borrowing firm never
  -- collects an individual's Aadhaar.
  party_kind            text check (party_kind in ('person', 'organisation')),

  -- For scope = 'property'.
  property_roles        app.case_property_role[],

  -- mandatory / optional / not_applicable, from the master data seeded in
  -- 0016. 'not_applicable' is a rule switched off for a reason worth keeping:
  -- the row stays readable and emits nothing. Distinct from is_active, which
  -- is "this rule is not in service" — business users mean different things
  -- by the two, so both are offered.
  applicability_id      uuid not null references requirement_applicability (id),

  applicable_from_stage app.progression_stage not null default 'documents_pending',

  -- Trailing financial years for a recurring document type (ITR, GST returns,
  -- balance sheet, P&L, banking). Null means one period-less row. The engine
  -- expands this into one document_requirement per year, each carrying its own
  -- period_start/period_end (0011) — a lender asking for two years' returns
  -- gets two rows, not one row either year can satisfy.
  financial_years       smallint check (financial_years is null or financial_years between 1 and 10),

  -- Whether every condition must hold, or any one of them.
  condition_match       text not null default 'all' check (condition_match in ('all', 'any')),

  is_active             boolean not null default true,
  display_order         integer not null default 0,

  -- Why this rule exists, in the words of whoever added it. Prose, never
  -- parsed — the same discipline lender_insight.body keeps (ADR-034).
  notes                 text,

  created_at            timestamptz not null default now(),
  created_by            uuid references app_user (id),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references app_user (id),

  -- A party_roles list on a property rule (or vice versa) is not a rule with
  -- an unusual configuration, it is a rule someone mis-saved.
  constraint document_requirement_rule_scope_is_coherent
    check (
      case scope
        when 'party'    then property_roles is null
        when 'property' then party_roles is null and party_kind is null
        when 'case'     then party_roles is null and party_kind is null and property_roles is null
      end
    )
);

comment on table document_requirement_rule is
  'The Document Requirement Engine (ADR-035). Every document AOS asks for is '
  'generated from a row here — there is no hardcoded checklist anywhere in '
  'the application. Seeded with researched defaults (0022) which a business '
  'user may then edit, disable or extend without a deploy. '
  'src/domain/requirements/rules.ts evaluates these; '
  'Docs/Document Requirement Engine.md explains how to add one.';

comment on column document_requirement_rule.code is
  'Stable handle, quoted in generated requirements so the "why is this being '
  'asked for?" answer survives the rule being renamed later.';

create index document_requirement_rule_active_idx
  on document_requirement_rule (display_order)
  where is_active;

create index document_requirement_rule_document_type_idx
  on document_requirement_rule (document_type_id);

-- ---------------------------------------------------------------------------
-- document_requirement_rule_condition
-- ---------------------------------------------------------------------------
create table document_requirement_rule_condition (
  id            uuid primary key default gen_random_uuid(),
  rule_id       uuid not null references document_requirement_rule (id) on delete cascade,

  -- A namespaced fact path: case.product_code, party.employment_type,
  -- property.type, ... Text rather than an enum ON PURPOSE. The authoritative
  -- list is FACT_PATHS in src/domain/requirements/rules.ts, and adding a fact
  -- always means capturing new data somewhere — it is a code change either
  -- way, so an enum here would buy a migration and no safety the domain layer
  -- does not already provide. A fact the engine does not recognise resolves to
  -- unknown rather than erroring, which is what keeps a half-edited rule from
  -- taking a case's checklist down.
  fact          text not null,

  operator      app.rule_condition_operator not null,

  -- The literals compared against. Unused by is_true / is_false / exists /
  -- absent, which ask about the fact itself rather than its value.
  values        text[],

  display_order integer not null default 0,

  constraint rule_condition_values_present_when_needed
    check (
      operator in ('is_true', 'is_false', 'exists', 'absent')
      or (values is not null and array_length(values, 1) >= 1)
    )
);

comment on table document_requirement_rule_condition is
  'When a rule fires. Zero conditions means unconditional — PAN, for every '
  'individual who signs. All conditions must hold, unless the rule''s '
  'condition_match says any.';

create index document_requirement_rule_condition_rule_idx
  on document_requirement_rule_condition (rule_id);

-- ---------------------------------------------------------------------------
-- document_requirement — provenance and strength
-- ---------------------------------------------------------------------------

alter table document_requirement
  add column generated_by_rule_id uuid references document_requirement_rule (id),
  add column applicability_id     uuid references requirement_applicability (id);

comment on column document_requirement.generated_by_rule_id is
  'Which rule asked for this. Nullable: a requirement added by hand for one '
  'extra financial year (selectableFinancialYears / addFinancialYearRequirement) '
  'has no rule behind it, and a row generated before 0021 has none either. A '
  'checklist nobody can interrogate is a checklist people work around, so '
  'this is the "why am I being asked for this?" answer.';

comment on column document_requirement.applicability_id is
  'mandatory or optional, carried down from the rule. Optional requirements '
  'are shown, collected and verified like any other but are excluded from '
  'progress arithmetic — an optional document nobody chased must not be able '
  'to hold a complete file at 94%%. Null reads as mandatory, so rows that '
  'predate this column behave exactly as before.';

-- ---------------------------------------------------------------------------
-- The facts a rule can ask about, on the tables that hold them.
--
-- Three on the case and three on the party. None of them existed because
-- nothing needed them: before the engine, requirement generation branched on
-- the product code and the person's employment record and nothing else. The
-- brief's dependency examples — construction estimate only after a
-- construction loan, GST only if GST-registered — each name a fact, and a
-- fact has to be recorded somewhere before a rule can read it.
-- ---------------------------------------------------------------------------

alter table loan_case
  add column is_gst_registered      boolean,
  add column construction_stage     app.construction_stage,
  add column has_existing_obligations boolean;

comment on column loan_case.is_gst_registered is
  'Is the borrowing business registered under GST? Deliberately NULLABLE and '
  'three-valued: null is "nobody has asked yet", which is different from '
  'false. Rules use is_true / is_false precisely so an unanswered question '
  'never silently generates (or suppresses) a GST requirement.';

comment on column loan_case.construction_stage is
  'Drives the staged construction documents. Null on every non-construction '
  'product.';

comment on column loan_case.has_existing_obligations is
  'Is anyone on this file already servicing a loan? Drives the existing-loan '
  'statement requirement. Nullable for the same reason as is_gst_registered.';

alter table case_party
  add column employment_type_id        uuid references employment_type (id),
  add column borrower_type_id          uuid references borrower_type (id),
  add column business_constitution_id  uuid references business_constitution (id);

comment on column case_party.employment_type_id is
  'This party''s employment type ON THIS CASE, overriding what their current '
  'employment record says. Set when the two genuinely differ — a person who '
  'has since changed jobs, or who is being underwritten on a different income '
  'from the one on file. Null means "use the person''s employment record", '
  'which is the normal case and keeps the fact in exactly one place '
  '(Principle #5). A case screen must never rewrite a shared person record to '
  'change one case''s requirements.';

comment on column case_party.borrower_type_id is
  'Resident individual, NRI or non-individual, for this case. NRI status is a '
  'property of how someone is borrowing, not only of who they are — the same '
  'person may hold a resident home loan and an NRI one.';

comment on column case_party.business_constitution_id is
  'Overrides organisation.business_constitution_id (ADR-014) for this case. '
  'Same reasoning as employment_type_id: null means use the organisation''s.';

-- ---------------------------------------------------------------------------
-- Touch trigger and row level security, matching every other table's
-- convention (0001, 0010). A table shipped without RLS is a table that is
-- readable by anyone who reaches the database, and ADR-027 makes that a test
-- failure rather than an oversight discovered later.
-- ---------------------------------------------------------------------------

create trigger document_requirement_rule_touch
  before update on document_requirement_rule
  for each row execute function app.touch_updated_at();

do $$
declare
  t text;
begin
  foreach t in array array[
    'document_requirement_rule', 'document_requirement_rule_condition'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end;
$$;
