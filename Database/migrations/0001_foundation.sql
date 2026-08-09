-- ===========================================================================
-- 0001 — Foundation: schemas, extensions, and the shared vocabulary
--
-- Every enum below mirrors a constant in src/domain/. The domain layer is the
-- single definition (ADR-022's pattern, applied beyond permissions); these types
-- exist so the database can refuse a value the domain would never produce.
--
-- The rule for what becomes an enum and what becomes a table:
--
--   Enum  — vocabulary Amaze owns, that changes on a timescale worth a code
--           review. Case stages, lost reasons, submission statuses.
--   Table — vocabulary that must absorb the outside world, or that requirement
--           templates key off. Document types, rejection reasons (ADR-025,
--           ADR-028).
--
-- Getting that line wrong in either direction is expensive: an enum that should
-- have been a table makes every addition a deploy, and a table that should have
-- been an enum makes every value a runtime surprise.
-- ===========================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;    -- fuzzy name search (Identity Resolution Part 7)
create extension if not exists citext;     -- case-insensitive email and codes

-- Helper functions and security definers live here. Application clients are
-- never granted usage on their contents except where explicitly granted
-- (ADR-026).
create schema if not exists app;

comment on schema app is
  'Internal helpers: permission checks, case-number allocation, identifier '
  'reveal. Clients call named functions; they never read these tables directly.';

-- ---------------------------------------------------------------------------
-- Access vocabulary — mirrors src/domain/permissions/
-- ---------------------------------------------------------------------------

-- Declaration order is the containment order: own < team < all. Postgres
-- compares enum values by declaration position, so `scope >= 'team'` is a
-- native comparison and app.has_permission() needs no rank table. This is the
-- same ordering as SCOPE_RANK in scopes.ts, and it must stay in step.
create type app.scope as enum ('own', 'team', 'all');

comment on type app.scope is
  'Permission scope. Ordered: all implies team implies own (BR-064, ADR-022). '
  'Declaration order is load-bearing — see src/domain/permissions/scopes.ts.';

create type app.role as enum (
  'telecaller',
  'login_executive',
  'manager',
  'finance',
  'admin',
  -- Employee Authentication milestone. Added directly to this enum, not a
  -- later `alter type ... add value`, because no SQL in Database/ has ever
  -- been run against a real database (Docs/Session Checkpoint.md) — there is
  -- no live enum to migrate. Full operational access plus user
  -- administration; see src/domain/permissions/roles.ts.
  'managing_partner'
);

-- ---------------------------------------------------------------------------
-- Case vocabulary — mirrors src/domain/case/stages.ts
-- ---------------------------------------------------------------------------

create type app.case_stage as enum (
  'new',
  'contacted',
  'appointment_fixed',
  'documents_pending',
  'ready_for_submission',
  'submitted',
  'sanctioned',
  'disbursed',
  'closed',
  'lost'
);

comment on type app.case_stage is
  'Where the customer journey stands. One value, always (BR-014). A different '
  'axis from submission status (ADR-004). The last two are terminal and have no '
  'ordinal position (ADR-023).';

-- Deliberately narrower than case_stage: the eight non-terminal stages only.
-- A requirement "applicable from lost" is not a statement with a meaning, and
-- the type is what stops one being written (ADR-023).
create type app.progression_stage as enum (
  'new',
  'contacted',
  'appointment_fixed',
  'documents_pending',
  'ready_for_submission',
  'submitted',
  'sanctioned',
  'disbursed'
);

create type app.lost_reason as enum (
  'rate_too_high',
  'sanctioned_elsewhere',
  'customer_not_eligible',
  'documents_unavailable',
  'property_issue',
  'customer_postponed',
  'unreachable',
  'not_interested',
  'duplicate_case'
);

comment on type app.lost_reason is
  'Why a case will not proceed. An enum, not master data, because this is '
  'Amaze''s own view and changes on a timescale worth a code review — unlike '
  'rejection_reason, which must absorb other organisations'' vocabulary '
  '(ADR-028).';

create type app.case_party_role as enum (
  'applicant',
  'co_applicant',
  'guarantor',
  'referrer',
  'borrower_firm'
);

create type app.case_property_role as enum ('collateral', 'purchase', 'both');

-- ---------------------------------------------------------------------------
-- Submission vocabulary — mirrors PRD/Workflow.md
-- ---------------------------------------------------------------------------

create type app.submission_status as enum (
  'not_submitted',
  'submitted',
  'under_process',
  'query_raised',
  'eligibility_received',
  'sanctioned',
  'rejected',
  'withdrawn',
  'disbursed'
);

comment on type app.submission_status is
  'Where one file at one bank stands. NOT a linear chain: query_raised loops '
  'back to under_process, and rejected/withdrawn are exits reachable from '
  'several points. not_submitted is a real state — chosen bank, product and '
  'contact, file not yet dispatched. PRD/Workflow.md is authoritative.';

-- ---------------------------------------------------------------------------
-- Requirement vocabulary — mirrors src/domain/requirements/progress.ts
-- ---------------------------------------------------------------------------

create type app.requirement_status as enum (
  'pending',
  'received',
  'verified',
  'waived',
  'not_applicable'
);

comment on type app.requirement_status is
  'waived and not_applicable are excluded from progress arithmetic entirely '
  '(BR-034), which is what lets a simple case reach 100% (ADR-011).';

-- ---------------------------------------------------------------------------
-- Identity vocabulary — mirrors PRD/Identity Resolution.md
-- ---------------------------------------------------------------------------

-- Aadhaar is deliberately absent. V1 stores no Aadhaar number and does not use
-- it as a match key (ADR-017). The document image may be held with the number
-- masked, as a `document` — never as an identifier. Adding it here later is a
-- small migration; having stored it unlawfully is an incident.
create type app.identifier_type as enum ('phone', 'pan', 'email', 'bank_account');

create type app.verification_source as enum (
  'self_declared',
  'seen_on_document',
  'verified_against_issuer'
);

comment on type app.verification_source is
  'How much weight the matching score may place on an identifier. A PAN seen on '
  'a document is near-definitive; one somebody recited is not.';

create type app.alias_source as enum ('typed_by_user', 'from_document', 'previous_spelling', 'merge');

-- ---------------------------------------------------------------------------
-- Organisation and people vocabulary
-- ---------------------------------------------------------------------------

create type app.organisation_role as enum (
  'employer',
  'borrower',
  'builder',
  'developer',
  'vendor',
  'lender',
  'branch'
);

comment on type app.organisation_role is
  'Roles overlap constantly — a construction firm is a builder on one case, a '
  'vendor on another, and somebody''s employer on a third — so roles are flags '
  'on one row, not separate tables (ADR-014).';

create type app.lender_type as enum ('bank', 'nbfc', 'hfc');

create type app.referrer_type as enum ('customer', 'bank_manager', 'agent', 'builder', 'staff');

create type app.employment_type as enum ('salaried', 'self_employed', 'business_owner');

comment on type app.employment_type is
  'Drives requirement generation, which is why employment is a modelled '
  'relationship rather than a field on person — it changes, and the history '
  'matters when a bank asks about job stability.';

-- ---------------------------------------------------------------------------
-- Documents, work and events
-- ---------------------------------------------------------------------------

create type app.document_owner_kind as enum ('person', 'property', 'organisation', 'case');

comment on type app.document_owner_kind is
  'Exactly one owner per document, never two (BR-030, ADR-007). An Aadhaar '
  'belongs to a person; a sale deed to a property; a sanction letter to a case.';

create type app.communication_channel as enum ('call', 'whatsapp', 'email', 'sms', 'meeting');

create type app.communication_direction as enum ('inbound', 'outbound');

create type app.event_actor_kind as enum ('user', 'system');

comment on type app.event_actor_kind is
  'Every event names an actor (BR-052). System transitions cite the change that '
  'caused them, so nobody wonders who moved their case (ADR-019).';

create type app.event_source as enum ('ui', 'automation', 'import');

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest without asking every caller
-- ---------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function app.touch_updated_at is
  'Maintains updated_at. A timestamp the application is trusted to set is a '
  'timestamp that is wrong in the one code path nobody remembered.';

-- ---------------------------------------------------------------------------
-- Shared guard: immutability
-- ---------------------------------------------------------------------------

create or replace function app.reject_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Table % is append-only; % is not permitted.', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

comment on function app.reject_change is
  'Refuses UPDATE and DELETE on append-only tables. Revoking the privilege is '
  'not enough on its own: a superuser session, a migration, or a future '
  'SECURITY DEFINER function would bypass it, and BR-051 admits no exceptions.';
