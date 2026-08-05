-- ===========================================================================
-- 0010 — Security defaults: deny everything, then grant deliberately
--
-- ADR-026 decided one mechanism, applied identically everywhere:
--
--   Row visibility  — RLS on the base table.
--   Column visibility — a masked view, which clients read INSTEAD of the base
--                       table. Base tables are revoked from client roles.
--
-- This migration installs the deny half. **No policies and no views are created
-- here.** Every table has RLS enabled with no policy, which in Postgres means
-- no client row is visible — the safe direction, and the one that makes the
-- next migration's omissions loud rather than silent.
--
-- The policies and views are the next unit of work, deliberately separated so
-- the schema can be audited before a security surface is built on top of it.
-- Until then this schema is deployable and inert: migrations and SECURITY
-- DEFINER functions work, client sessions see nothing.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- app.current_user_id — the anchor every policy hangs from
-- ---------------------------------------------------------------------------

create or replace function app.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id
    from app_user
   where auth_identity_id = auth.uid()
     and is_active;
$$;

comment on function app.current_user_id is
  'The app_user for the current session, or null. Every RLS policy starts here. '
  'Returns null for a deactivated account, so deactivating a user takes effect '
  'on their next query rather than at their next login (BR-062 keeps their '
  'history attributed regardless).';

-- ---------------------------------------------------------------------------
-- app.has_permission — the only reader of user_role and role_permission
-- ---------------------------------------------------------------------------

create or replace function app.has_permission(
  p_permission text,
  p_required   app.scope default 'own'
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from user_role ur
      join role_permission rp on rp.role = ur.role
     where ur.user_id = app.current_user_id()
       and ur.revoked_at is null
       and rp.permission = p_permission
       -- Enum comparison, not a rank lookup: app.scope is declared own < team
       -- < all, so `all` satisfies a requirement of `own` natively. A user
       -- holding several roles is satisfied by whichever grants the most,
       -- which is the union semantics BR-061 requires.
       and rp.scope >= p_required
  );
$$;

comment on function app.has_permission is
  'The single authority on whether the current session holds a permission at a '
  'scope. SECURITY DEFINER because user_role and role_permission are not '
  'readable by clients — a client that could read them could not change them, '
  'but a client that could JOIN them into a policy could infer another user''s '
  'grants. Both RLS policies and view masking expressions call this and nothing '
  'else (ADR-026).';

-- ---------------------------------------------------------------------------
-- app.scope_of — which scope the session holds, for policies that branch on it
-- ---------------------------------------------------------------------------

create or replace function app.scope_of(p_permission text)
returns app.scope
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select max(rp.scope)
    from user_role ur
    join role_permission rp on rp.role = ur.role
   where ur.user_id = app.current_user_id()
     and ur.revoked_at is null
     and rp.permission = p_permission;
$$;

comment on function app.scope_of is
  'The widest scope the session holds for a permission, or null. Lets a policy '
  'skip the expensive ownership predicate entirely when the answer is `all`, '
  'which matters because the case-derived `own` predicate reaches into '
  'case_party and is on the hot path of nearly every read (ADR-027).';

-- ---------------------------------------------------------------------------
-- Deny by default
--
-- Enabling RLS with no policy denies every client row. FORCE additionally
-- applies it to the table owner, so a mistake in a future SECURITY DEFINER
-- function cannot quietly read everything.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'person', 'person_identifier', 'person_alias',
    'app_user', 'user_role', 'role_permission', 'permission',
    'referrer_profile', 'bank_contact', 'employment',
    'organisation', 'organisation_alias', 'lender_profile',
    'loan_product', 'bank_product', 'document_type',
    'operational_threshold', 'rejection_reason',
    'property',
    'case_number_sequence', 'loan_case', 'case_party', 'case_property',
    'document', 'document_requirement',
    'submission', 'submission_query', 'offer',
    'task', 'communication', 'note', 'event'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Revoke the base tables from client roles
--
-- Under ADR-026 clients read VIEWS, never base tables, because column masking
-- is a view expression and a client with base-table access would bypass it.
-- Writes go to base tables through the domain layer, which holds a role that is
-- granted explicitly when the write path is built.
--
-- `authenticated` and `anon` are Supabase's client roles. Revoking from PUBLIC
-- as well closes the default grant that would otherwise apply to any role added
-- later.
-- ---------------------------------------------------------------------------

revoke all on all tables    in schema public from public;
revoke all on all sequences in schema public from public;
revoke all on all functions in schema public from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables    in schema public from authenticated';
    execute 'revoke all on all sequences in schema public from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables    in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
  end if;
end;
$$;

-- Future tables inherit the same denial, so a table added without a policy is
-- inert rather than open. This is the database-level counterpart of the test in
-- src/domain/permissions/tables.ts that fails when a table has no binding
-- (ADR-027) — one catches it at build time, the other at deploy time.
alter default privileges in schema public revoke all on tables from public;

-- The app schema holds the security definers. Clients call named functions and
-- never read anything in it directly.
revoke all on schema app from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant usage on schema app to authenticated';
    execute 'grant execute on function app.has_permission(text, app.scope) to authenticated';
    execute 'grant execute on function app.current_user_id() to authenticated';
    execute 'grant execute on function app.scope_of(text) to authenticated';
    -- allocate_case_number is deliberately NOT granted: case numbers are
    -- allocated by the case-creation path, and a client that could call it
    -- directly could burn numbers and create gaps (ADR-024).
  end if;
end;
$$;
