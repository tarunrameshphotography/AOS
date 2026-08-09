-- ===========================================================================
-- 0030 — Sending a case's documents to a banker, by email
--
-- 0024 built the address book and stopped there, in as many words: "WHAT THIS
-- MIGRATION DOES NOT DO, and must not be extended to do: send anything." It
-- also named the seam this migration attaches to — "Submission packages → a
-- package is a set of `document` rows chosen for one `submission`; that is a
-- junction table against two tables that both already exist." That is exactly
-- what follows.
--
-- WHAT HAPPENS IN THE OFFICE TODAY. Management decides a file goes to HDFC
-- Bank. Somebody opens the Windows folder, attaches scans to a Gmail message
-- until Gmail complains, starts a second message, and sends. Nothing records
-- which documents went, in which email, to whom, or whether the third one
-- bounced. "Did you get the FY 2023-24 return?" is a weekly phone call, and
-- the only evidence anything was sent at all lives in one person's Sent items.
--
-- Four tables, and each exists because a specific question has to survive:
--
--   submission_package            Who sent what, when, to which bank, and how
--                                 it went overall.
--   submission_package_recipient  The addresses it actually went to,
--                                 snapshotted.
--   submission_package_email      One outgoing email. Its own status, because
--                                 two of three can succeed.
--   submission_package_document   Which document, at which VERSION, in which
--                                 email. Exactly once.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not store message bodies (see the
-- comment on submission_package_email.subject), does not model WhatsApp, does
-- not hold credentials of any kind, and does not touch the document
-- requirement engine, the financial-year logic or the permission catalog —
-- sending a file to a bank is `submission.create`, which the Login Desk,
-- Manager and Managing Partner already hold and a Telecaller already does not
-- (src/domain/permissions/roles.ts). No new permission is introduced by this
-- milestone, deliberately.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Part 1 — the package
--
-- One act of sending. Not one per email: the user chose a set of documents and
-- pressed Send once, and that decision is the thing worth recording. How many
-- emails it took is a consequence of file sizes, which is an implementation
-- detail of the mail provider and not a business event.
--
-- A second send to the same banker is a NEW package, never an edit of the old
-- one — the same reasoning that makes a corrected file returning to a branch a
-- new submission (Workflow.md) rather than a reset of the old.
-- ---------------------------------------------------------------------------

create table submission_package (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid not null references submission (id),

  -- Who pressed Send. Not nullable and not the case owner: this is the person
  -- who put customer documents into an outgoing email, and BR-032's principle
  -- — the system never does it, a named human does — applies at least as
  -- strongly here as it does to verification.
  initiated_by      uuid not null references app_user (id),
  initiated_at      timestamptz not null default now(),

  -- The mailbox it went FROM, snapshotted. If the office moves from
  -- amazeloans@gmail.com to a Workspace address next year, what a historical
  -- submission says it was sent from must not change (ADR-036's argument,
  -- applied to the sender).
  sender_address    text not null,
  sender_name       text not null,

  -- Which provider carried it: 'gmail' today. Recorded because a delivery
  -- question a year from now is answered differently depending on whose sent
  -- mailbox to look in.
  provider          text not null,

  -- Rolled up from the emails below, and deliberately allowed to say
  -- 'partially_sent'. Reporting a submission as sent when one of three emails
  -- failed is the single most damaging thing this table could do.
  status            text not null default 'pending',

  document_count    integer not null,
  email_count       integer not null,
  total_bytes       bigint not null,

  completed_at      timestamptz,

  constraint submission_package_status_known
    check (status in ('pending', 'sent', 'partially_sent', 'failed')),
  constraint submission_package_counts_positive
    check (document_count > 0 and email_count > 0)
);

comment on table submission_package is
  'One act of sending a case''s verified documents to a banker (ADR-039). The '
  'unit is the DECISION — a user chose documents and pressed Send once — not '
  'the emails it took to carry them, which is a consequence of file sizes. A '
  'later send to the same banker is a new package, never an edit of this one, '
  'for the reason a corrected file returning to a branch is a new submission '
  '(Workflow.md).';

comment on column submission_package.initiated_by is
  'The employee who sent it. Never null and never the system: customer '
  'documents leaving the building is a decision with a name on it, the same '
  'principle BR-032 applies to verification.';

comment on column submission_package.sender_address is
  'The mailbox this went out from, snapshotted. Not read from configuration '
  'at display time: configuration changes and what a historical submission '
  'says it did must not change with it (ADR-036).';

comment on column submission_package.status is
  'pending / sent / partially_sent / failed. `partially_sent` is the reason '
  'this column is not a boolean — a submission of eight documents across '
  'three emails can succeed twice and fail once, and reporting that as '
  '"sent" would stop somebody chasing a bank that never received the file.';

create index submission_package_submission_idx
  on submission_package (submission_id);

-- ---------------------------------------------------------------------------
-- Part 2 — who it went to
--
-- Snapshotted, not read through `submission_recipient`, for the reason the
-- whole of 0024's Part 2 exists: a manager moving on edits the catalogue and
-- must not edit history. The defaults come from `submission_recipient`, and an
-- address typed on the spot is equally valid — a workflow that only accepts
-- catalogued addresses is one people work around.
-- ---------------------------------------------------------------------------

create table submission_package_recipient (
  id                     uuid primary key default gen_random_uuid(),
  submission_package_id  uuid not null references submission_package (id),

  -- Where it came from, when it came from anywhere.
  submission_recipient_id uuid references submission_recipient (id),

  email                  text not null,
  contact_name           text,
  recipient_kind         text not null default 'to',
  display_order          integer not null default 0,

  constraint submission_package_recipient_kind_known
    check (recipient_kind in ('to', 'cc')),
  -- The same expression as `submission_recipient_email_shaped` (0024) and as
  -- `isEmailShaped` in src/domain/submissions/recipients.ts, deliberately: a
  -- rule enforced in three places with three definitions is a rule that will
  -- disagree with itself.
  constraint submission_package_recipient_email_shaped
    check (email ~ '^[^@[:space:],;]+@[^@[:space:],;]+\.[^@[:space:],;]+$')
);

comment on table submission_package_recipient is
  'The addresses one package actually went to, snapshotted at the moment of '
  'sending (ADR-039). Defaults come from `submission_recipient`, but this is '
  'not a view of it: a package may go to a subset of the bankers on the '
  'submission, or to an address typed on the spot, and editing the catalogue '
  'afterwards must not rewrite who received a file.';

comment on column submission_package_recipient.recipient_kind is
  'to / cc. Unlike `submission_recipient.recipient_kind`, which records the '
  'office''s intent, this records what was actually put on the message.';

create unique index submission_package_recipient_one_email
  on submission_package_recipient (submission_package_id, lower(btrim(email)));

create index submission_package_recipient_package_idx
  on submission_package_recipient (submission_package_id);

-- ---------------------------------------------------------------------------
-- Part 3 — one outgoing email
--
-- ITS OWN STATUS IS THE WHOLE POINT. Three emails go out; the third is refused
-- because a token expired between the second and the third. Without a row per
-- email there is nowhere to record that, no way to tell the user which one
-- failed, and no way to retry the failed one WITHOUT resending the two the
-- banker already has.
--
-- `attempt_count` exists so a retry is visible as a retry. A row that quietly
-- flips from failed to sent hides the fact that the first attempt happened,
-- and "the bank says they got it twice" becomes unanswerable.
-- ---------------------------------------------------------------------------

create table submission_package_email (
  id                     uuid primary key default gen_random_uuid(),
  submission_package_id  uuid not null references submission_package (id),

  -- 1-based, and the number the subject line says out loud: "(2/3)".
  sequence               integer not null,

  -- The subject, and ONLY the subject. The body is deterministic — it is
  -- recomputed from the case, the recipient and this email's own documents by
  -- src/domain/submissions/compose.ts — so storing it would duplicate
  -- customer data into a second place for no information gained (ADR-018's
  -- objection to duplicated personal data, and this milestone's own
  -- instruction not to store email contents the audit model does not need).
  -- The subject is stored because it is not derivable after the fact: it
  -- depends on how the documents happened to split, and the office needs to
  -- be able to say "we sent you the email titled X".
  subject                text not null,

  status                 text not null default 'pending',
  attachment_count       integer not null,
  attachment_bytes       bigint not null,

  attempt_count          integer not null default 0,
  sent_at                timestamptz,
  provider_message_id    text,

  -- The provider's own category and words, kept apart. The category is what a
  -- retry decides on; the words are what a person reads. Collapsing them into
  -- one free-text column would make "was this worth retrying?" a string match.
  failure_kind           text,
  failure_message        text,

  constraint submission_package_email_status_known
    check (status in ('pending', 'sent', 'failed')),
  constraint submission_package_email_sequence_positive
    check (sequence > 0),
  -- A sent email has a time on it; a failed one has a reason. Neither is
  -- optional, because a row that says 'sent' with no timestamp is a row
  -- nobody can date and a row that says 'failed' with no reason is one
  -- nobody can act on.
  constraint submission_package_email_sent_is_dated
    check (status <> 'sent' or sent_at is not null),
  constraint submission_package_email_failed_has_reason
    check (status <> 'failed' or failure_kind is not null),
  -- The attachment ceiling, enforced at the database as well as in
  -- src/domain/submissions/attachments.ts. Ten binary megabytes, matching
  -- MAX_ATTACHMENT_BYTES_PER_EMAIL exactly. A rule this milestone calls the
  -- hard business rule should not rely on the application remembering it.
  constraint submission_package_email_within_size_limit
    check (attachment_bytes <= 10 * 1024 * 1024)
);

comment on table submission_package_email is
  'One outgoing email within a package (ADR-039). A row per email, with its '
  'own status, is what makes partial failure representable: three emails go '
  'out, the third is refused, and the user must be told exactly that and be '
  'able to retry the third WITHOUT resending the two the banker already has.';

comment on column submission_package_email.subject is
  'The subject line as sent. The body is deliberately NOT stored — it is '
  'regenerated deterministically from the case by compose.ts, so keeping it '
  'would copy customer data into a second place for nothing. The subject is '
  'not derivable after the fact, because it names what happened to land in '
  'this particular email.';

comment on column submission_package_email.attempt_count is
  'How many times this email has been attempted. A retry that silently '
  'flipped a row from failed to sent would hide that a first attempt '
  'happened, and "the bank says they received it twice" would be '
  'unanswerable.';

comment on constraint submission_package_email_within_size_limit on submission_package_email is
  'The hard business rule: no individual outgoing email exceeds 10 MB of '
  'attachments. Ten BINARY megabytes, matching MAX_ATTACHMENT_BYTES_PER_EMAIL '
  'in src/domain/submissions/attachments.ts and matching how file sizes are '
  'rendered on screen — a user shown "9.7 MB" and refused at 10 MB must not '
  'be looking at two different megabytes.';

create unique index submission_package_email_sequence_unique
  on submission_package_email (submission_package_id, sequence);

create index submission_package_email_package_idx
  on submission_package_email (submission_package_id);

-- ---------------------------------------------------------------------------
-- Part 4 — which documents, at which version, in which email
--
-- The junction 0024 predicted. Three properties matter and each is enforced
-- rather than trusted:
--
--   EXACTLY ONCE. A document appears in one email of one package — the unique
--   index below. "Every selected document is sent" and "no document is
--   silently omitted" are only checkable if duplication is impossible.
--
--   THE VERSION ACTUALLY SENT. `document_version` is copied, not joined. A
--   document replaced next month gets a new row in `document` (BR-031); the
--   number here is what the banker actually holds, and no amount of later
--   re-uploading changes it.
--
--   WHICH EMAIL. Without it, a retry cannot know what to re-attach, and the
--   answer to "which email had the ITRs?" is a guess.
-- ---------------------------------------------------------------------------

create table submission_package_document (
  id                          uuid primary key default gen_random_uuid(),
  submission_package_id       uuid not null references submission_package (id),
  submission_package_email_id uuid not null references submission_package_email (id),
  document_id                 uuid not null references document (id),

  -- Snapshotted from `document` at the moment of sending.
  document_version            integer not null,
  file_name                   text not null,
  file_size_bytes             bigint not null,
  -- "2024-25", where the document is financial-year scoped. Snapshotted so
  -- the year a banker was sent stays attached to the document that was sent,
  -- independently of anything the requirement rows do later.
  financial_year_label        text,

  display_order               integer not null default 0,

  constraint submission_package_document_version_positive
    check (document_version > 0)
);

comment on table submission_package_document is
  'Which document, at which version, went in which email (ADR-039). The '
  'junction table 0024 predicted. `document_version` is copied rather than '
  'joined because a document replaced next month gets a new row under BR-031 '
  'and the number here is what the banker actually holds.';

comment on column submission_package_document.financial_year_label is
  'The financial year this document covers, as sent. Snapshotted so a year '
  'stays attached to the document a banker received, whatever the case''s '
  'requirement rows do afterwards.';

-- Exactly once per package. This index is the enforcement of "every selected
-- document appears in exactly one batch".
create unique index submission_package_document_once
  on submission_package_document (submission_package_id, document_id);

create index submission_package_document_email_idx
  on submission_package_document (submission_package_email_id);

create index submission_package_document_document_idx
  on submission_package_document (document_id);

-- ---------------------------------------------------------------------------
-- Row security, in the shape 0021 and 0024 used. All four tables belong to the
-- `case-derived` family (ADR-027): they are governed by their parent
-- submission, and shipping any of them without RLS would make it a readable
-- back door into a case's documents.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'submission_package',
    'submission_package_recipient',
    'submission_package_email',
    'submission_package_document'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- What this deliberately did NOT create
--
-- No credential table, no token store, no `oauth_account`. Provider secrets
-- live in environment configuration and never in the database, never in a
-- migration and never in the repository (ADR-039).
--
-- No WhatsApp tables. The seam is
-- src/domain/communications/whatsapp-provider.ts and there is nothing to
-- store until an implementation exists — an empty table plus a screen nobody
-- fills is exactly what ADR-028 refuses.
--
-- No message body column, and none should be added without a stated reason:
-- the body is regenerated from the case, and a second copy of customer data
-- is a redaction problem (ADR-018) bought for no information.
-- ---------------------------------------------------------------------------
