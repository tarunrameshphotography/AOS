-- ===========================================================================
-- 0029 — Employee authentication: login credentials, per-user overrides
--
-- AOS has had a permission model since 0002/0008 but no way to actually log
-- in — the frontend prototype picked "who is using AOS" from a switchable
-- localStorage value. This migration adds what real login needs on top of
-- the existing app_user/user_role tables (both untouched otherwise): a
-- username and a password hash to authenticate with, and a table for
-- per-user permission grants/denials that sit on top of role_permission
-- (Employee Authentication milestone).
--
-- Not touched: document rules, financial-year logic, bank catalogue,
-- storage. The `managing_partner` value on app.role is added in 0001, not
-- here — see that migration's comment for why.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- app_user — login credentials
-- ---------------------------------------------------------------------------

alter table app_user
  add column username      text unique,
  add column password_hash text;

comment on column app_user.username is
  'The employee ID they log in with. Unique, case handled by the application '
  '(comparisons are case-insensitive there, not enforced here).';

comment on column app_user.password_hash is
  'PBKDF2-SHA256, one-way (src/domain/auth/password.ts). Never plaintext, '
  'never read back by any client-facing view. This column is the prototype''s '
  'stand-in for a real identity provider — app_user.auth_identity_id is where '
  'production authentication is meant to live (see that column''s comment); '
  'this one exists because the frontend has no such provider to delegate to '
  'yet.';

-- ---------------------------------------------------------------------------
-- user_permission_override
-- ---------------------------------------------------------------------------

create table user_permission_override (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_user (id),
  permission   text not null references permission (key),
  scope        app.scope not null,
  decision     text not null,
  granted_by   uuid references app_user (id),
  granted_at   timestamptz not null default now(),
  revoked_by   uuid references app_user (id),
  revoked_at   timestamptz,

  constraint user_permission_override_decision_known
    check (decision in ('grant', 'deny')),
  constraint user_permission_override_revocation_is_complete
    check ((revoked_by is null) = (revoked_at is null))
);

comment on table user_permission_override is
  'An explicit grant or deny of one permission for one user, on top of what '
  'their roles give them (Employee Authentication milestone). Precedence is '
  'deterministic: an active deny beats an active grant, which beats the '
  'role-derived answer alone — src/domain/permissions/overrides.ts is the one '
  'implementation of that rule. Revoked, never deleted, mirroring user_role: '
  'a permission someone was granted or denied last month is part of why '
  'access looked the way it did.';

comment on column user_permission_override.decision is
  '''grant'' or ''deny''. A deny blocks the permission outright, at every '
  'scope; a grant widens the role-derived scope up to at least this row''s '
  'scope and never narrows it.';

create index user_permission_override_user_idx
  on user_permission_override (user_id)
  where revoked_at is null;

-- Deny by default, same as every table 0010 enabled RLS on — this table is
-- created after 0010 runs, so it enables its own here rather than joining
-- that migration's loop over a table that did not exist yet when it ran.
do $$
begin
  execute format('alter table %I enable row level security', 'user_permission_override');
  execute format('alter table %I force row level security', 'user_permission_override');
end;
$$;
