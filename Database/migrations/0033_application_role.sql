-- ===========================================================================
-- 0033 — The application role: AOS stops connecting to Postgres as a superuser
--
-- WHAT WAS WRONG (Stage 4 audit, finding H3). `Backend/db.ts` builds its pool
-- from AOS_DB_USER, which `.env.example` and `Docs/Installation.md` both set
-- to `postgres`. That role is `rolsuper = true, rolbypassrls = true`, and it
-- owns every table in this schema. Two consequences, both measured against a
-- live database rather than inferred:
--
--   1. Row level security in AOS protected NOTHING. A superuser bypasses RLS
--      unconditionally — FORCE included. 0010 enabled RLS on 62 tables and
--      created no policies; `select count(*) from pg_policies` returned 0. The
--      security surface was not merely incomplete, it was inert, and the
--      README said so about the policies while saying nothing about the role.
--
--   2. Any SQL injection, and anyone who obtained AOS_DB_PASSWORD, held the
--      whole machine: COPY ... FROM PROGRAM is arbitrary code execution as the
--      PostgreSQL service account, pg_read_server_files reads the document
--      tree, pg_authid yields every role's password hash, and `delete from
--      event` erases the record of all of it. The office server PC is the same
--      machine that holds C:\AOS\Data and the backups.
--
-- THE TRAP THIS ALSO REMOVES. Because RLS was on with no policies, the obvious
-- remedy — "just point AOS_DB_USER at a normal role" — would have made every
-- query return zero rows, with no error, and AOS would have appeared to lose
-- all its data. The configuration was one step away from either a breach or an
-- outage and gave no signal which. After this migration a normal role works.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not change how anything connects.
-- `aos_app` is created with NO PASSWORD, so it cannot authenticate until an
-- administrator sets one (Docs/Installation.md §5a). An installation that
-- never takes that step behaves exactly as it did before. Switching is two
-- lines of `.env` and is reversible by reverting them.
--
-- Additive only: CREATE ROLE, GRANT, CREATE POLICY. Nothing is dropped, no
-- table changes owner, and no row is touched.
--
-- THIS MIGRATION MUST BE RUN BY A SUPERUSER. `create role` and `comment on
-- role` both require it, and roles are cluster-wide rather than per-database,
-- so this is the one migration that reaches outside the AOS database.
-- `Docs/Installation.md` has migrations running as `postgres`, which is
-- correct and stays correct: the point of this file is that the APPLICATION
-- stops being a superuser, not that nothing ever is.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- The role
--
-- Every attribute here is a NEGATIVE one, which is the point: this role is
-- defined by what it cannot do. It owns nothing, so it holds no implicit
-- privilege on any table and cannot ALTER or DROP one. It is created inside a
-- guard because CREATE ROLE is cluster-wide, not per-database — a second AOS
-- database on the same PostgreSQL instance must not fail to migrate because
-- the first one already made the role.
--
-- NO PASSWORD IS SET. A role with no password cannot authenticate under
-- scram-sha-256, so creating it opens nothing. The office sets one once, out
-- of band; a migration file that carried a password would put it in git.
--
-- NOINHERIT: the role does not automatically pick up privileges of any role it
-- is later granted membership in. If someone one day adds `aos_app` to a group
-- for a one-off task, that must be a deliberate SET ROLE, not a silent
-- widening of what the running API can do.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'aos_app') then
    create role aos_app
      login
      nosuperuser
      nobypassrls
      nocreatedb
      nocreaterole
      noinherit
      noreplication;
  else
    -- Idempotent, and it re-asserts the attributes rather than assuming them:
    -- a role that already exists might have been created by hand, by an older
    -- version of this file, or granted something since.
    alter role aos_app
      login nosuperuser nobypassrls nocreatedb nocreaterole noinherit noreplication;
  end if;
end;
$$;

comment on role aos_app is
  'The role Backend/api-server.ts connects as. NOSUPERUSER and NOBYPASSRLS so '
  'the RLS policies below actually apply to it, owns nothing so it holds no '
  'DDL privilege, and is granted no DELETE on any table so BR-003 ("nothing is '
  'hard-deleted") is enforced by PostgreSQL rather than by the application '
  'happening not to write one. Migrations, seed-users and bootstrap-production '
  'run as the OWNER, not as this role.';


-- ---------------------------------------------------------------------------
-- Schema access
--
-- USAGE only. USAGE on a schema is the right to name what is in it; it grants
-- nothing on any object. CREATE is withheld from all three, so this role
-- cannot add a table, a function or a type anywhere — which is what makes
-- "owns nothing" durable rather than merely true today.
--
-- The revokes are belt-and-braces: `aos_app` was never granted CREATE, and on
-- PostgreSQL 15+ PUBLIC no longer holds it on `public` either. They are here so
-- that a cluster restored from an older dump, or one where somebody granted it
-- by hand, converges on the same answer.
-- ---------------------------------------------------------------------------

grant usage on schema public to aos_app;
grant usage on schema app    to aos_app;
grant usage on schema auth   to aos_app;

revoke create on schema public from aos_app;
revoke create on schema app    from aos_app;
revoke create on schema auth   from aos_app;


-- ---------------------------------------------------------------------------
-- Table privileges
--
-- Three tiers, and the shape of them is decided by what the API demonstrably
-- does, not by what seemed prudent. The write set was established by reading
-- every `insert into` and `update ... set` in Backend/ — see the comment on
-- CATALOGUE below for why that is a safe way to draw the line here.
--
-- DELETE APPEARS NOWHERE. Not on one table. The request-handling path in
-- Backend/ issues no DELETE at all — the only `delete from` statements in the
-- repository are in src/domain/permissions/seed.ts, which is migration tooling
-- that runs as the owner. BR-003 and BR-062 have been conventions held by the
-- code that happened to be written; withholding the privilege makes them a
-- property of the database, at zero behavioural cost, and turns an injected
-- `delete from loan_case` into a permission error instead of data loss.
-- ---------------------------------------------------------------------------

-- Tier 1: operational data. The API creates and amends these.
grant select, insert, update on
  person,
  person_identifier,
  person_alias,
  app_user,
  user_role,
  user_permission_override,
  api_session,
  organisation,
  organisation_alias,
  lender_profile,
  referrer_profile,
  bank_contact,
  employment,
  property,
  loan_case,
  case_party,
  case_property,
  document,
  document_requirement,
  submission,
  submission_recipient,
  submission_query,
  submission_package,
  submission_package_document,
  submission_package_recipient,
  submission_package_email,
  offer,
  task,
  communication,
  note
to aos_app;

-- Tier 2: the event log. INSERT and SELECT, and deliberately no UPDATE — an
-- audit trail that the audited process can rewrite is not an audit trail. With
-- no DELETE granted anywhere either, `event` is append-only as far as the
-- application is concerned, which is what BR-052 has always meant.
grant select, insert on event to aos_app;

-- Tier 3: catalogue and reference data. SELECT only.
--
-- These are seeded by migrations (0008, 0009, 0013, 0016, 0018, 0020, 0022,
-- 0025) and read by the API through Backend/reference.ts and Backend/lenders.ts.
-- No route in api-server.ts writes any of them: there is no master-data
-- administration surface in the API, so this is not a restriction on anything
-- that currently happens. `permission` and `role_permission` are here rather
-- than in tier 1 for a sharper reason — they ARE the permission model, and a
-- compromised query that could rewrite a role's grants would not need to
-- defeat authorize.ts at all. src/domain/permissions/seed.ts writes them as
-- the owner during migration; nothing else ever should.
grant select on
  permission,
  role_permission,
  operational_threshold,
  loan_product,
  loan_product_borrower_type,
  loan_product_business_constitution,
  loan_product_employment_type,
  bank_product,
  customer_product,
  borrower_type,
  business_constitution,
  employment_type,
  document_type,
  document_requirement_rule,
  document_requirement_rule_condition,
  requirement_applicability,
  rejection_reason,
  referral_source,
  security_type,
  property_type,
  property_ownership_type,
  submission_mode,
  bank_branch,
  lender_type,
  lender_insight,
  lender_insight_category,
  lender_relationship_role,
  lender_submission_rule,
  city,
  district
to aos_app;

-- `case_number_sequence` is not granted at all. Case numbers are allocated
-- exclusively through app.allocate_case_number(), which is SECURITY DEFINER
-- and therefore touches the sequence table as the owner. A role that could
-- write the table directly could burn numbers and create gaps (ADR-024).
--
-- `schema_migrations` is not granted either: the migration ledger is the
-- runner's business, and the API has no reason to read or write it.


-- ---------------------------------------------------------------------------
-- Sequence and function privileges
--
-- Every primary key here is `uuid default gen_random_uuid()`, so there is no
-- sequence the application drives — but `grant usage on all sequences` is
-- written anyway, scoped to this schema, because a future `serial` column
-- would otherwise fail at INSERT time with an error naming the sequence rather
-- than the design decision.
-- ---------------------------------------------------------------------------

grant usage, select on all sequences in schema public to aos_app;

-- Exactly the four functions the API calls, and no blanket grant on the schema.
-- 0010 revoked EXECUTE on everything in `app` from PUBLIC; this re-opens the
-- named few.
--
-- allocate_case_number IS granted here, unlike to Supabase's `authenticated`
-- role in 0010, and the distinction is the whole architecture: `authenticated`
-- was a BROWSER holding a JWT, and a browser that can burn case numbers is a
-- browser that can put gaps in the sequence. `aos_app` is the API server
-- itself, which is the only thing that ever creates a case.
grant execute on function app.current_user_id()                         to aos_app;
grant execute on function app.has_permission(text, app.scope)           to aos_app;
grant execute on function app.scope_of(text)                            to aos_app;
grant execute on function app.allocate_case_number(integer)             to aos_app;
grant execute on function auth.uid()                                    to aos_app;


-- ---------------------------------------------------------------------------
-- Row level security: the policies 0010 deliberately left for later
--
-- READ THIS BEFORE ASSUMING WHAT THESE DO. They are a containment boundary
-- around the CONNECTION, not a re-statement of the authorization model.
--
-- WHAT IS NOT HERE, AND WHY. There is no per-user or per-case policy. AOS
-- decides who may see which case in Backend/authorize.ts — `canActOnCase`,
-- `widestScopeFor` — which calls `hasPermissionWithOverrides` from
-- src/domain/permissions/, the same function the UI calls and the same catalog
-- migration 0008 seeds. ADR-022 exists to keep that question answered ONCE. A
-- second implementation of it in SQL would not add a boundary; it would add a
-- copy that drifts, and the drift would be invisible until the day the two
-- disagreed about somebody's access. Ownership stays in authorize.ts, where
-- Backend/api.test.ts proves it.
--
-- WHAT IS HERE. Two tiers.
--
--   Tier A — the login path. app_user, api_session, person, user_role,
--            user_permission_override and the permission catalog must be
--            readable BEFORE any identity exists, because reading them is how
--            an identity comes to exist. `using (true)`, stated openly. RLS
--            cannot constrain the credential check that precedes it, and a
--            policy pretending otherwise would be decoration.
--
--   Tier B — everything else. `app.current_user_id() is not null`: the
--            transaction must have published the identity of an ACTIVE
--            employee (set_config('app.auth_identity_id', ...) in
--            Backend/db.ts, then again in api-server.ts once the token has
--            been exchanged).
--
-- WHAT TIER B ACTUALLY BUYS, stated without inflation: a connection holding
-- the aos_app password but NOT inside an authenticated AOS transaction cannot
-- read a single customer, case, document or submission row. A leaked .env, a
-- psql session from another PC on the office LAN, a backup script pointed at
-- the wrong credentials — none of them see operational data. It also means a
-- deactivated employee is refused by PostgreSQL and not only by loadActor,
-- because app.current_user_id() filters on is_active.
--
-- WHAT IT DOES NOT BUY: a SQL injection inside an already-authenticated
-- request passes this policy, because that request legitimately has an
-- identity. Tier B is defence in depth against a stolen credential. It is not
-- a substitute for authorize.ts and nothing in AOS should describe it as one.
--
-- COST: the Tier B predicate references no column, so PostgreSQL evaluates it
-- once per statement as an InitPlan rather than once per row. It does not
-- touch the case_party join that 0010 worried about in app.scope_of.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  -- Reachable before an identity exists, because establishing one requires
  -- reading them. `person` is here because app_user joins to it for the
  -- employee's name on the login response, and `permission` / `role_permission`
  -- because loadActor resolves roles in the same breath.
  tier_a text[] := array[
    'app_user', 'api_session', 'person', 'user_role',
    'user_permission_override', 'permission', 'role_permission'
  ];
  tier_b text[] := array[
    'person_identifier', 'person_alias',
    'organisation', 'organisation_alias', 'lender_profile', 'referrer_profile',
    'bank_contact', 'employment', 'property',
    'loan_case', 'case_party', 'case_property',
    'document', 'document_requirement',
    'submission', 'submission_recipient', 'submission_query',
    'submission_package', 'submission_package_document',
    'submission_package_recipient', 'submission_package_email',
    'offer', 'task', 'communication', 'note', 'event',
    'operational_threshold', 'loan_product',
    'loan_product_borrower_type', 'loan_product_business_constitution',
    'loan_product_employment_type', 'bank_product', 'customer_product',
    'borrower_type', 'business_constitution', 'employment_type',
    'document_type', 'document_requirement_rule',
    'document_requirement_rule_condition', 'requirement_applicability',
    'rejection_reason', 'referral_source', 'security_type',
    'property_type', 'property_ownership_type', 'submission_mode',
    'bank_branch', 'lender_type', 'lender_insight', 'lender_insight_category',
    'lender_relationship_role', 'lender_submission_rule', 'city', 'district'
  ];
begin
  foreach t in array tier_a loop
    execute format(
      'create policy aos_app_login_path on %I for all to aos_app using (true) with check (true)', t);
  end loop;

  foreach t in array tier_b loop
    execute format(
      'create policy aos_app_authenticated on %I for all to aos_app '
      'using (app.current_user_id() is not null) '
      'with check (app.current_user_id() is not null)', t);
  end loop;
end;
$$;

comment on function app.current_user_id is
  'The app_user for the current session, or null. Every RLS policy starts here. '
  'Returns null for a deactivated account, so deactivating a user takes effect '
  'on their next query rather than at their next login (BR-062 keeps their '
  'history attributed regardless). As of 0033 this is load-bearing rather than '
  'aspirational: the aos_app tier-B policies refuse every operational table '
  'when it returns null.';


-- ---------------------------------------------------------------------------
-- Default privileges
--
-- 0010 revoked default privileges from PUBLIC so a new table would be inert
-- rather than open. The same reasoning in the other direction does NOT apply
-- here: a table added by a future migration must NOT silently become readable
-- by aos_app, because it would arrive with no policy and — being ungranted —
-- would fail loudly the first time the API touched it. That is the correct
-- failure. Whoever adds the table adds its grant and its policy in the same
-- migration, and Backend/security.test.ts fails the build if they forget the
-- policy.
--
-- Recorded as a deliberate omission rather than left silent, because "why is
-- there no ALTER DEFAULT PRIVILEGES for aos_app here" is exactly the question
-- the next person will ask.
-- ---------------------------------------------------------------------------
