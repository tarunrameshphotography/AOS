-- ===========================================================================
-- 0002 — Identity and access
--
-- person, its evidence and aliases, the accounts that log in, and the permission
-- catalog the whole security model reads from.
--
-- These tables are created together because they reference each other: every
-- audited row names the app_user who created it, and app_user is itself a
-- person. The circular foreign keys are added at the end of this file.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- person
-- ---------------------------------------------------------------------------
create table person (
  id                uuid primary key default gen_random_uuid(),

  -- Nullable, deliberately. Redaction under ADR-018 nulls personal columns in
  -- place, leaving a tombstone the surviving cases and events still point at.
  -- NOT NULL here would make erasure impossible without deleting the row, which
  -- BR-003 forbids. Do not "fix" this.
  full_name         text,
  date_of_birth     date,
  address_line      text,
  locality          text,
  city              text,
  pincode           text,

  -- Merge leaves the loser as a tombstone that redirects to the survivor
  -- (BR-004). Old links, old case references and old searches still resolve.
  merged_into_id    uuid references person (id),
  merged_at         timestamptz,

  is_active         boolean     not null default true,
  redacted_at       timestamptz,

  created_at        timestamptz not null default now(),
  created_by        uuid,
  updated_at        timestamptz not null default now(),

  constraint person_merge_is_complete
    check ((merged_into_id is null) = (merged_at is null)),
  constraint person_merge_is_not_self
    check (merged_into_id is null or merged_into_id <> id),
  -- A redacted person has no name left to show. Stated so that "redacted" and
  -- "we never knew their name" cannot be confused when reading the data.
  constraint person_redaction_clears_name
    check (redacted_at is null or full_name is null)
);

comment on table person is
  'Every human AOS knows, exactly once. Customer, employee, referrer and bank '
  'manager are roles a person plays, not types of person — they overlap in real '
  'life and separate tables would split one human into several records with '
  'drifting phone numbers (ADR-006). Required by BR-001. PRD/Data Model.md, '
  'PRD/Identity Resolution.md Part 3.';

comment on column person.merged_into_id is
  'Tombstone redirect. The row is never deleted and the merge is reversible '
  '(BR-005).';

create index person_active_idx on person (is_active) where merged_into_id is null;
create index person_name_trgm_idx on person using gin (full_name gin_trgm_ops);
create index person_locality_idx on person (locality) where locality is not null;

-- ---------------------------------------------------------------------------
-- person_identifier
-- ---------------------------------------------------------------------------
create table person_identifier (
  id                  uuid primary key default gen_random_uuid(),
  person_id           uuid not null references person (id),
  identifier_type     app.identifier_type not null,

  -- What was typed, kept verbatim. value_normalised is what matching compares:
  -- phone stripped to digits, PAN upper-cased, email lower-cased.
  value_raw           text not null,
  value_normalised    text not null,

  is_primary          boolean not null default false,

  -- Validity is what makes recycled numbers safe. In India a disconnected
  -- mobile is reissued: a number identifying a customer in 2024 can belong to a
  -- stranger in 2027, who would otherwise silently inherit that person's cases
  -- and history. A 2024 call is attributed to whoever held the number in 2024
  -- (ADR-013).
  valid_from          date not null default current_date,
  valid_to            date,

  verification_source app.verification_source not null default 'self_declared',

  created_at          timestamptz not null default now(),
  created_by          uuid,
  updated_at          timestamptz not null default now(),

  constraint person_identifier_validity_ordered
    check (valid_to is null or valid_to >= valid_from)
);

comment on table person_identifier is
  'The evidence by which a person is recognised. No identifier is identity '
  '(BR-002) — identity is the surrogate person.id (BR-001, ADR-013). Aadhaar is '
  'deliberately absent from app.identifier_type (ADR-017). '
  'PRD/Identity Resolution.md Part 3.';

comment on column person_identifier.value_normalised is
  'The match key. Masked in the client view alongside value_raw: leaving it '
  'exposed would let anyone reconstruct the raw value by probing (ADR-026).';

-- PAN is exclusive to one person and near-definitive when read off a document,
-- so a verified PAN is unique across people. Phone deliberately is NOT unique:
-- numbers are shared and recycled, so a collision prompts rather than blocks
-- (ADR-013, Data Model constraint 1).
create unique index person_identifier_verified_pan_unique
  on person_identifier (value_normalised)
  where identifier_type = 'pan'
    and verification_source <> 'self_declared'
    and valid_to is null;

create index person_identifier_lookup_idx
  on person_identifier (identifier_type, value_normalised);

-- Phone-suffix search: "9843..." must find a person (Identity Resolution Part 7).
create index person_identifier_suffix_idx
  on person_identifier using gin (value_normalised gin_trgm_ops);

create index person_identifier_person_idx on person_identifier (person_id);

create unique index person_identifier_one_primary_per_type
  on person_identifier (person_id, identifier_type)
  where is_primary and valid_to is null;

-- ---------------------------------------------------------------------------
-- person_alias
-- ---------------------------------------------------------------------------
create table person_alias (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references person (id),
  alias       text not null,
  source      app.alias_source not null,
  created_at  timestamptz not null default now(),
  created_by  uuid,

  constraint person_alias_not_blank check (length(btrim(alias)) > 0)
);

comment on table person_alias is
  'Every wrong-but-used spelling of a name. Transliterated Tamil names have no '
  'single correct spelling and frequently no surname — Sasi Rekha / Sasirekha / '
  'Sashirekha are one person — and the wrong spelling is what somebody will type '
  'next time. A merge adds the loser''s name here automatically (BR-004). '
  'PRD/Identity Resolution.md Part 3.';

create index person_alias_person_idx on person_alias (person_id);
create index person_alias_trgm_idx on person_alias using gin (alias gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- app_user
-- ---------------------------------------------------------------------------
create table app_user (
  id               uuid primary key default gen_random_uuid(),
  person_id        uuid not null unique references person (id),

  -- The link to the authentication provider's session identity. Every RLS
  -- policy starts here: a policy asks "which user is this?" and this is the
  -- answer. A row without one cannot log in and should not exist.
  auth_identity_id uuid not null unique,

  is_active        boolean not null default true,
  last_login_at    timestamptz,

  created_at       timestamptz not null default now(),
  created_by       uuid,
  updated_at       timestamptz not null default now()
);

comment on table app_user is
  'A person who can log into AOS. One-to-one with person, optional — most people '
  'AOS knows are customers, not users. Named app_user because "user" is reserved '
  'in Postgres. Note there is no role column: a user holds many roles and '
  'receives the union of their permissions (BR-061, ADR-022). Deactivated, never '
  'deleted — their name must survive on every case they touched (BR-062). '
  'PRD/Data Model.md, PRD/Permissions.md.';

comment on column app_user.auth_identity_id is
  'Supabase auth.users.id. Every RLS policy depends on it.';

create index app_user_active_idx on app_user (is_active);

-- ---------------------------------------------------------------------------
-- permission — the catalog, as rows
-- ---------------------------------------------------------------------------
create table permission (
  key           text primary key,
  permission_group text not null,
  level         text not null,
  description   text not null,

  constraint permission_key_shape check (key ~ '^[a-z_]+\.[a-z_]+$'),
  constraint permission_level_known check (level in ('row', 'column'))
);

comment on table permission is
  'The permission catalog, seeded from src/domain/permissions/actions.ts. Exists '
  'so role_permission can carry a foreign key: without it a typo in a grant is a '
  'silently dead permission rather than a failed migration. Required by ADR-027 '
  '("every permission has a target"). PRD/Permissions.md.';

comment on column permission.level is
  'row — an RLS policy on the base table. column — a masking expression in the '
  'view the client reads (ADR-026). Exactly two permissions are column-level.';

-- ---------------------------------------------------------------------------
-- role_permission
-- ---------------------------------------------------------------------------
create table role_permission (
  role       app.role  not null,
  permission text      not null references permission (key),
  scope      app.scope not null,

  primary key (role, permission)
);

comment on table role_permission is
  'Which permissions a role carries, at which scope. Seeded by migration from '
  'src/domain/permissions/roles.ts, which is the single definition — never '
  'hand-written in SQL, because two definitions of one rule always drift '
  '(ADR-022). app.has_permission() is the only reader. Required by BR-064. '
  'PRD/Permissions.md, Docs/Permission Matrix.md.';

-- ---------------------------------------------------------------------------
-- user_role
-- ---------------------------------------------------------------------------
create table user_role (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_user (id),
  role         app.role not null,
  granted_by   uuid,
  granted_at   timestamptz not null default now(),
  revoked_by   uuid,
  revoked_at   timestamptz,

  constraint user_role_revocation_is_complete
    check ((revoked_by is null) = (revoked_at is null))
);

comment on table user_role is
  'Role assignments. Runtime data, never a migration: adding a role to someone '
  'is a configuration change (ADR-022). A user holds many roles at once and '
  'receives the union of their permissions (BR-061) — which is why a login '
  'executive who also makes calls needs one account, not two, and two accounts '
  'for one human is how audit trails start lying. PRD/Permissions.md.';

comment on column user_role.revoked_at is
  'Revocation is a timestamp, not a delete. A role somebody held last March is '
  'part of why a record looks the way it does.';

create unique index user_role_one_live_grant
  on user_role (user_id, role)
  where revoked_at is null;

create index user_role_user_idx on user_role (user_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- referrer_profile
-- ---------------------------------------------------------------------------
create table referrer_profile (
  person_id        uuid primary key references person (id),
  referrer_type    app.referrer_type not null,

  -- Masked behind commercial.view in the client view (ADR-026). Free text
  -- rather than a modelled payout schedule: whether AOS calculates commission
  -- at all is an open question in PRD/Data Model.md, and modelling a payout
  -- engine before that is answered would be building for an imagined future.
  commission_terms text,

  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  created_by       uuid,
  updated_at       timestamptz not null default now()
);

comment on table referrer_profile is
  'A person who sends business, and the terms they send it on. An extension '
  'table on person rather than a separate entity, because a referrer is a role a '
  'person plays and frequently plays alongside being a customer (ADR-006). '
  'PRD/Data Model.md.';

comment on column referrer_profile.commission_terms is
  'Masked behind commercial.view. Written under person.update — and no role '
  'currently holds both, which is a flagged open question in PRD/Permissions.md.';

-- ---------------------------------------------------------------------------
-- The circular references, now that both ends exist
-- ---------------------------------------------------------------------------
alter table person            add constraint person_created_by_fk            foreign key (created_by) references app_user (id);
alter table person_identifier add constraint person_identifier_created_by_fk foreign key (created_by) references app_user (id);
alter table person_alias      add constraint person_alias_created_by_fk      foreign key (created_by) references app_user (id);
alter table app_user          add constraint app_user_created_by_fk          foreign key (created_by) references app_user (id);
alter table referrer_profile  add constraint referrer_profile_created_by_fk  foreign key (created_by) references app_user (id);
alter table user_role         add constraint user_role_granted_by_fk         foreign key (granted_by) references app_user (id);
alter table user_role         add constraint user_role_revoked_by_fk         foreign key (revoked_by) references app_user (id);

-- created_by is nullable on purpose: the seeding migration creates rows before
-- any user exists, and an import would too. Every row created through the
-- application has one.

create trigger person_touch            before update on person            for each row execute function app.touch_updated_at();
create trigger person_identifier_touch before update on person_identifier for each row execute function app.touch_updated_at();
create trigger app_user_touch          before update on app_user          for each row execute function app.touch_updated_at();
create trigger referrer_profile_touch  before update on referrer_profile  for each row execute function app.touch_updated_at();
