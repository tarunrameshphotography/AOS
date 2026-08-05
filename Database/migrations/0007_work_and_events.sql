-- ===========================================================================
-- 0007 — Work, communication and the event log
--
-- Tasks are intent. Events are fact. They are never merged.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- task
-- ---------------------------------------------------------------------------
create table task (
  id            uuid primary key default gen_random_uuid(),
  case_id       uuid references loan_case (id),

  -- Every task has exactly one assignee (BR-040). An unowned task is not going
  -- to be done.
  assigned_to   uuid not null references app_user (id),

  title         text not null,
  detail        text,
  due_at        timestamptz,
  priority      smallint not null default 3,

  completed_at  timestamptz,
  completed_by  uuid references app_user (id),

  created_at    timestamptz not null default now(),
  created_by    uuid references app_user (id),
  updated_at    timestamptz not null default now(),

  constraint task_title_not_blank check (length(btrim(title)) > 0),
  constraint task_priority_range check (priority between 1 and 5),
  constraint task_completion_is_complete
    check ((completed_at is null) = (completed_by is null))
);

comment on table task is
  'Something a human must do, in the future. Tasks are INTENT; events are FACT, '
  'and merging them would make "what did we plan" and "what happened" one '
  'question with one answer. A task is either open or completed-by-someone and '
  'is never deleted (BR-041) — a deleted task hides the fact that work was '
  'dropped. PRD/Data Model.md.';

comment on column task.case_id is
  'Optional: not every task belongs to a case. An offer nearing expiry raises '
  'one that does; a personal reminder does not.';

create index task_open_idx on task (assigned_to, due_at) where completed_at is null;
create index task_case_idx on task (case_id) where case_id is not null;

-- ---------------------------------------------------------------------------
-- communication
-- ---------------------------------------------------------------------------
create table communication (
  id                  uuid primary key default gen_random_uuid(),
  case_id             uuid references loan_case (id),
  person_id           uuid not null references person (id),

  channel             app.communication_channel not null,
  direction           app.communication_direction not null,
  occurred_at         timestamptz not null default now(),
  subject             text,
  body                text,

  external_message_id text,

  recorded_by         uuid references app_user (id),
  created_at          timestamptz not null default now()
);

comment on table communication is
  'A real exchange with a person: call, WhatsApp, email, SMS, meeting. Logged '
  'against BOTH the person and the case, so a person''s full history is visible '
  'from their profile across every case — which is the point of one person '
  'table (ADR-006). Not editable after the fact: a record of what was said is '
  'not a draft. PRD/Data Model.md.';

comment on column communication.person_id is
  'Attribution is to the person, not to a phone number. A call logged in 2024 '
  'belongs to whoever held that number in 2024 (ADR-013), which is resolved at '
  'the moment of logging via person_identifier validity.';

create index communication_case_idx on communication (case_id) where case_id is not null;
create index communication_person_idx on communication (person_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- note
-- ---------------------------------------------------------------------------
create table note (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references loan_case (id),
  author_id  uuid not null references app_user (id),
  body       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint note_body_not_blank check (length(btrim(body)) > 0)
);

comment on table note is
  'Internal commentary on a case. Immutable after a short edit window, enforced '
  'in policy rather than here so the window is one number in one place. Notes '
  'are NOT a place to store structured facts — if something is being written in '
  'notes repeatedly, it wants a field (Principle #11), because a rejection '
  'reason buried in a note is a fact the company cannot learn from. Known '
  'redaction leak under ADR-018: users will type names into them, and that is a '
  'policy question rather than a schema one. PRD/Data Model.md.';

create index note_case_idx on note (case_id, created_at desc);

-- ---------------------------------------------------------------------------
-- event
-- ---------------------------------------------------------------------------
create table event (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),

  actor_kind    app.event_actor_kind not null,
  actor_user_id uuid references app_user (id),

  entity_type   text not null,
  entity_id     uuid,
  case_id       uuid references loan_case (id),

  event_type    text not null,

  -- Payloads reference people and organisations by ID ONLY. No embedded names,
  -- phone numbers or identifier values, ever. The event log is never redacted
  -- (BR-051), so any personal data copied into a payload would be unerasable
  -- and would defeat ADR-018. Denormalising personal data into an event is
  -- prohibited, not discouraged.
  payload_before jsonb,
  payload_after  jsonb,

  source        app.event_source not null default 'ui',

  -- A system transition cites the change that caused it, so nobody wonders who
  -- moved their case (ADR-019).
  caused_by_entity_type text,
  caused_by_entity_id   uuid,

  -- BR-052: every event names an actor. A user event names the user; a system
  -- event explicitly names the system, which is why actor_user_id is nullable
  -- but only for system events.
  constraint event_actor_is_named
    check ((actor_kind = 'user') = (actor_user_id is not null))
);

comment on table event is
  'The append-only spine. State tables hold current truth; every state change '
  'also appends here, IN THE SAME TRANSACTION, or the change does not happen '
  '(BR-050) — an audit trail with gaps is not an audit trail. This is a log, '
  'NOT event sourcing: rebuilding state by replay would make every query a fold '
  'and every bug an archaeology exercise, which a small team will not maintain '
  '(ADR-005). Every timeline, audit trail, MIS report, productivity metric and '
  'AI summary reads from here. Never updated, never deleted (BR-051): the event '
  'skeleton survives redaction, so the fact that a case existed, moved and was '
  'lost outlives the personal detail (ADR-018). PRD/Data Model.md.';

comment on column event.payload_before is
  'IDs only. A name or phone number here would be unerasable personal data and '
  'is prohibited (ADR-018). A merge carries the full before-state of both '
  'records, which is what makes it reversible (BR-005) — and those records are '
  'referenced, not copied.';

create index event_case_idx on event (case_id, occurred_at desc) where case_id is not null;
create index event_entity_idx on event (entity_type, entity_id, occurred_at desc);
create index event_actor_idx on event (actor_user_id, occurred_at desc) where actor_user_id is not null;
create index event_type_idx on event (event_type, occurred_at desc);

-- BR-051 admits no exceptions, so it is a trigger and not merely a revoked
-- privilege: a superuser session, a migration or a future SECURITY DEFINER
-- function would bypass a privilege.
create trigger event_is_append_only
  before update or delete on event
  for each row execute function app.reject_change();

create trigger communication_is_immutable
  before update or delete on communication
  for each row execute function app.reject_change();

create trigger task_touch before update on task for each row execute function app.touch_updated_at();
create trigger note_touch before update on note for each row execute function app.touch_updated_at();
