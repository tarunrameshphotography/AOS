-- ===========================================================================
-- 0031 — API sessions
--
-- WHY THIS TABLE EXISTS: AOS is moving from one browser's localStorage to a
-- shared backend (Persistence milestone). Employees on different PCs now
-- authenticate against an API rather than picking a user from a list, and an
-- authenticated request has to carry something the server can verify. That
-- something needs a home.
--
-- WHY NOT IN MEMORY: the office runs one backend on one PC. An in-memory
-- session map would log every employee out whenever that process restarted —
-- including on a Windows update at 3am — and would make "does the data survive
-- a backend restart?" untestable without a re-login step that hides the very
-- failure the test is looking for.
--
-- WHY THE TOKEN ITSELF IS NOT STORED: only its SHA-256 is. A stolen database
-- backup then yields no usable session, for the same reason `password_hash`
-- exists rather than a password column. The raw token is generated once, given
-- to the browser, and never written down by the server.
--
-- BR/ADR: extends the Employee Authentication milestone (0029), which added
-- `username`/`password_hash` to `app_user` but had no session concept because
-- the prototype never made a network call.
-- ===========================================================================

create table api_session (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references app_user (id),

  -- SHA-256 hex of the bearer token. Unique so a token identifies at most one
  -- session; indexed implicitly, which is what every authenticated request
  -- looks up.
  token_hash   text        not null unique,

  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,

  -- Touched on use, so an idle session can be distinguished from an active one
  -- when someone asks why a login is still open.
  last_seen_at timestamptz not null default now(),

  -- Logout. Set rather than deleted: BR-003's "nothing is hard-deleted" is as
  -- true of a session as of a case, and "when did they log out" is a question
  -- an audit will eventually ask.
  revoked_at   timestamptz,
  revoked_by   uuid        references app_user (id)
);

comment on table api_session is
  'A logged-in browser session. EXISTS BECAUSE employees on separate PCs must '
  'authenticate to a shared backend rather than selecting themselves from a '
  'list (Persistence milestone). RULE: only the SHA-256 of the bearer token is '
  'stored, never the token. ADR: extends Employee Authentication (0029). '
  'PRD: PRD/Permissions.md.';

comment on column api_session.token_hash is
  'SHA-256 hex of the bearer token. The token itself is never stored, so a '
  'database backup yields no usable session.';

comment on column api_session.revoked_at is
  'Logout time. Sessions are revoked, never deleted (BR-003).';

-- Expiry sweeps and "who is logged in" both filter live sessions by user.
create index api_session_user_live_idx
  on api_session (user_id)
  where revoked_at is null;

-- Consistent with every other table in this schema: RLS on, no policy, base
-- table unreadable by client roles (0010). Only the API server's own
-- connection touches this table.
-- No `updated_at` and so no `app.touch_updated_at()` trigger, unlike every
-- other table here: the only mutation a session ever receives is a touch of
-- `last_seen_at` or a `revoked_at`, both of which already say when they
-- happened. A second timestamp meaning "one of the other two changed" would
-- carry no information.
do $$
declare t text;
begin
  foreach t in array array[
    'api_session'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end;
$$;

revoke all on api_session from public;
