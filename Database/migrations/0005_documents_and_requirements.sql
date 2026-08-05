-- ===========================================================================
-- 0005 — Documents and requirements
--
-- A document is owned by the person or property it describes, not by the case
-- that references it (ADR-007). An Aadhaar card belongs to a person. Hanging
-- documents off cases forces a repeat customer to re-upload identical KYC for
-- every loan and creates multiple copies with diverging expiry dates — a direct
-- violation of "information is entered once" (Principle #5).
--
-- The payoff is visible in the product: a second case for an existing customer
-- opens with KYC already satisfied.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- document
-- ---------------------------------------------------------------------------
create table document (
  id               uuid primary key default gen_random_uuid(),

  -- Exactly one owner, never two (BR-030). Four kinds: person, property,
  -- organisation (a borrowing firm's GST certificate, ITR and financial
  -- statements — the reason Organisation became an entity at all, ADR-009), and
  -- case (only genuinely case-specific paperwork: the sanction letter, the
  -- login form).
  owner_kind       app.document_owner_kind not null,
  person_id        uuid references person (id),
  property_id      uuid references property (id),
  organisation_id  uuid references organisation (id),
  case_id          uuid references loan_case (id),

  document_type_id uuid not null references document_type (id),

  file_path        text not null,
  file_name        text,
  file_size_bytes  bigint,

  -- For statements and ITR, "which months?" is part of the identity of the
  -- document.
  period_start     date,
  period_end       date,
  issued_on        date,
  expires_on       date,

  -- Documents are versioned and never overwritten in place (BR-031): a replaced
  -- document may be the one a bank already saw.
  version          integer not null default 1,
  supersedes_document_id uuid references document (id),

  -- Verification is always an explicit human act with a name attached. The
  -- system never verifies a document (BR-032) — accountability for what went to
  -- the bank must rest with a person.
  verified_by      uuid references app_user (id),
  verified_at      timestamptz,

  uploaded_by      uuid references app_user (id),
  uploaded_at      timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint document_has_exactly_one_owner
    check (
      (case when person_id       is not null then 1 else 0 end) +
      (case when property_id     is not null then 1 else 0 end) +
      (case when organisation_id is not null then 1 else 0 end) +
      (case when case_id         is not null then 1 else 0 end) = 1
    ),

  -- owner_kind is not a second, disagreeable copy of which column is set — it
  -- must match. Without this the discriminator drifts from the data and every
  -- reader has to decide which to trust.
  constraint document_owner_kind_matches
    check (
      case owner_kind
        when 'person'       then person_id       is not null
        when 'property'     then property_id     is not null
        when 'organisation' then organisation_id is not null
        when 'case'         then case_id         is not null
      end
    ),

  constraint document_verification_is_complete
    check ((verified_by is null) = (verified_at is null)),
  constraint document_period_ordered
    check (period_end is null or period_start is null or period_end >= period_start),
  constraint document_version_positive check (version >= 1),
  constraint document_supersedes_is_not_self
    check (supersedes_document_id is null or supersedes_document_id <> id)
);

comment on table document is
  'One uploaded file, owned by the person, property, organisation or case it '
  'describes — never by two (BR-030, ADR-007). Versioned, never overwritten '
  '(BR-031). Never deleted: document.delete_version exists in the permission '
  'catalog and is granted to nobody. Verification is an explicit human act with '
  'a name attached (BR-032). PRD/Data Model.md.';

comment on column document.file_path is
  'A reference into object storage. The bytes are not in Postgres; storage-level '
  'access is governed by the same permission model.';

create index document_person_idx on document (person_id) where person_id is not null;
create index document_property_idx on document (property_id) where property_id is not null;
create index document_organisation_idx on document (organisation_id) where organisation_id is not null;
create index document_case_idx on document (case_id) where case_id is not null;
create index document_type_idx on document (document_type_id);

-- Unverified documents that have aged past the threshold degrade case health
-- (PRD/Requirements and Progress.md Part 4).
create index document_unverified_idx on document (uploaded_at) where verified_at is null;

create index document_expiry_idx on document (expires_on) where expires_on is not null;

-- ---------------------------------------------------------------------------
-- document_requirement
-- ---------------------------------------------------------------------------
create table document_requirement (
  id                  uuid primary key default gen_random_uuid(),
  case_id             uuid not null references loan_case (id),
  document_type_id    uuid not null references document_type (id),

  -- Typed references, not a description. A free-text "which party" would make
  -- "what is this co-applicant still missing?" a string comparison. At most one
  -- is set: a case-level requirement such as the login form belongs to no party.
  required_of_case_party_id    uuid references case_party (id),
  required_of_case_property_id uuid references case_property (id),

  status              app.requirement_status not null default 'pending',

  -- Drawn from the eight progression stages, not the ten case stages: closed
  -- and lost have no ordinal position, so "applicable from lost" is not a
  -- statement with a meaning (ADR-023). The type enforces it.
  applicable_from_stage app.progression_stage not null default 'documents_pending',

  -- Which document actually satisfied it. Without this a verified requirement
  -- cannot be traced to the file that verified it, and re-verifying after a new
  -- version becomes guesswork.
  satisfied_by_document_id uuid references document (id),

  -- A waiver sends an incomplete file to a bank. That is a decision with a name
  -- on it: who, when and why (BR-035).
  waived_by           uuid references app_user (id),
  waived_at           timestamptz,
  reason              text,

  created_at          timestamptz not null default now(),
  created_by          uuid references app_user (id),
  updated_at          timestamptz not null default now(),

  constraint document_requirement_subject_is_singular
    check (required_of_case_party_id is null or required_of_case_property_id is null),

  constraint document_requirement_waiver_is_complete
    check ((waived_by is null) = (waived_at is null)),

  -- BR-035: a waiver without a reason is not a waiver, it is a shortcut.
  constraint document_requirement_waiver_is_reasoned
    check (status <> 'waived' or (waived_by is not null and reason is not null)),

  constraint document_requirement_verified_has_document
    check (status <> 'verified' or satisfied_by_document_id is not null)
);

comment on table document_requirement is
  'What a given case still needs. Rows are GENERATED from the case''s actual '
  'composition, never from a universal checklist — a case with no guarantor '
  'generates no guarantor rows at all, not rows marked N/A (BR-033, ADR-011). '
  'Absence is silence (Principle #1). waived and not_applicable rows are '
  'excluded from progress arithmetic entirely (BR-034), which is what lets a '
  'simple case reach 100% — and a progress bar that can never fill on a simple '
  'case is one users learn to ignore, which destroys it as a signal '
  'permanently. This table powers the login desk''s one question: what is '
  'missing before this file can go to the bank? '
  'PRD/Requirements and Progress.md.';

comment on column document_requirement.status is
  'Regenerated, never deleted: a no-longer-relevant requirement becomes '
  'not_applicable (PRD/Workflow.md — loan product changes mid-case).';

create index document_requirement_case_idx on document_requirement (case_id);
create index document_requirement_outstanding_idx
  on document_requirement (case_id)
  where status in ('pending', 'received');
create index document_requirement_party_idx
  on document_requirement (required_of_case_party_id)
  where required_of_case_party_id is not null;
create index document_requirement_property_idx
  on document_requirement (required_of_case_property_id)
  where required_of_case_property_id is not null;

create trigger document_touch             before update on document             for each row execute function app.touch_updated_at();
create trigger document_requirement_touch before update on document_requirement for each row execute function app.touch_updated_at();
