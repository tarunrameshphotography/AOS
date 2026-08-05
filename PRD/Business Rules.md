# Business Rules

**Status:** Draft for review.

The laws of AOS, stated independently of any implementation. A rule here is not a
preference or a default — it is an invariant. If code can violate it, the code is
wrong.

Each rule states **what** must hold and **why**. Rules without a reason are
superstition and get deleted.

Where a rule can be enforced by the database, it must be. Application-layer
enforcement is a fallback, not a choice — application checks get forgotten in the
one code path nobody remembered.

---

## Naming

Rules are `BR-nnn`, grouped by area. Numbers are permanent. A withdrawn rule is
marked withdrawn, never reused.

---

## Identity

**BR-001** — Every person has a permanent system-generated Person ID that never
changes and carries no business meaning.
*Why:* Identity must survive changed phone numbers, corrected names and merges.

**BR-002** — No identifier (phone, PAN, email, Aadhaar) is identity. Identifiers
are evidence attached to a person, with a validity period.
*Why:* Numbers are shared, changed and recycled. See ADR-013.

**BR-003** — A person is never hard-deleted. They are deactivated or merged.
*Why:* Their name appears on cases, documents and events that must remain
readable.

**BR-004** — A merge preserves both records: the loser becomes a tombstone that
redirects to the survivor, and its name becomes an alias.
*Why:* Old links and old searches must still resolve, and the "wrong" spelling is
what someone will type again.

**BR-005** — Every merge is reversible, and carries the full before-state of both
records in its event.
*Why:* Merges are performed on judgement and judgement is sometimes wrong.

**BR-006** — Organisations, including banks and branches, follow BR-003 to BR-005
identically.
*Why:* One identity philosophy. See ADR-014.

---

## Cases

**BR-010** — Every case has exactly one primary applicant, at all times.
*Why:* A case without an applicant is not a case. This is the only mandatory
party.

**BR-011** — Every case has exactly one accountable owner at any moment.
Ownership can change; it cannot be absent or shared.
*Why:* Shared accountability is no accountability. "Whose case is this?" must
have one answer.

**BR-012** — All parties other than the primary applicant are optional, and an
absent party produces no record, no requirement and no interface element.
*Why:* Absence is silence. See ADR-010.

**BR-013** — A case is never hard-deleted. It ends as Closed or Lost, and Lost
always carries a reason.
*Why:* Lost cases are the most instructive data the company will accumulate.

**BR-014** — A case has exactly one stage at any time, drawn from the case
lifecycle — never from submission statuses.
*Why:* The two are different axes. See ADR-004.

---

## Submissions

**BR-020** — A submission belongs to exactly one case and exactly one bank
branch. It cannot exist without both.
*Why:* A submission is the act of sending a specific file to a specific place.

**BR-021** — A case may have many submissions, and each carries its own
independent status.
*Why:* Multi-bank submission is normal. See ADR-004.

**BR-022** — A case may have at most one submission in `Disbursed`.
*Why:* One loan is disbursed. Two would be a serious error, and the database
should make it impossible rather than merely unlikely.

**BR-023** — A submission cannot enter `Sanctioned` without an attached offer.
*Why:* "Sanctioned" with no amount, rate or tenure is not information.

**BR-024** — A submission entering `Rejected` must carry a **standardised
rejection category** drawn from the `rejection_reason` master-data table.
*Why:* Rejection reasons are the company's most valuable dataset. Free text alone
cannot be analysed.

**BR-025** — At most one offer per submission may be `accepted`.
*Why:* Accepting two competing offers from one bank is meaningless.

**BR-026** — A rejection may additionally carry the bank's own wording,
verbatim, and that wording never substitutes for the category.
*Why:* Banks describe one refusal in incompatible language — "FOIR exceeded",
"obligations high", "IIR norms not met" are one fact. The category is what
reports group by; the verbatim text is what proves the category was chosen
honestly, and what a disputed classification is checked against. See ADR-028.

**BR-027** — The rejection category list is master data, not an enum, and a
retired category is deactivated rather than deleted.
*Why:* New lenders arrive with new vocabulary on a timescale of weeks. If adding
a category needs a migration, people pick the nearest wrong value instead —
silently corrupting the one dataset the rule exists to protect. Deactivating
rather than deleting keeps historical submissions pointing at the category they
were classified under.

---

## Documents and requirements

**BR-030** — Every document has exactly one owner: a person, a property, an
organisation, or a case. Never two.
*Why:* Ambiguous ownership produces duplicates. See ADR-007.

**BR-031** — Documents are versioned and never overwritten in place.
*Why:* A replaced document may be the one a bank already saw.

**BR-032** — Verification is always attributed to a named human, with a
timestamp. The system never verifies a document.
*Why:* Accountability for what went to the bank must rest with a person.

**BR-033** — Requirements are generated from a case's actual composition, never
from a universal checklist.
*Why:* See ADR-011.

**BR-034** — `not_applicable` and `waived` requirements are excluded from progress
arithmetic entirely.
*Why:* A simple case must be able to reach 100%.

**BR-035** — Only explicitly authorised users may waive a requirement, and every
waiver records who, when and why.
*Why:* A waiver sends an incomplete file to a bank. That is a decision with a
name on it.

---

## Tasks and work

**BR-040** — Every task has exactly one assignee.
*Why:* An unowned task is not going to be done.

**BR-041** — A task is either open or completed-by-someone. Tasks are not
deleted.
*Why:* Deleted tasks hide the fact that work was dropped.

---

## Events and history

**BR-050** — Every state change writes an event, in the same transaction as the
change. If the event cannot be written, the change does not happen.
*Why:* An audit trail with gaps is not an audit trail. See ADR-005.

**BR-051** — The event log is append-only. Events are never updated and never
deleted.
*Why:* A rewritable history has no evidentiary value.

**BR-052** — Every event names an actor: a user, or explicitly the system.
*Why:* "It changed" is not an answer anyone can act on.

**BR-053** — Overriding a system safeguard — forcing a duplicate, waiving a
requirement, skipping a stage — is itself an event, with a reason.
*Why:* The overrides are precisely the moments worth reviewing later.

---

## Access

**BR-060** — Permission is enforced at the data layer, not only in the interface.
*Why:* A hidden button is not a permission.

**BR-061** — A user may hold multiple roles simultaneously, and receives the union
of their permissions.
*Why:* At this size people wear several hats. Two accounts for one human is how
audit trails start lying. See ADR-022.

**BR-062** — Deactivated users retain their historical attribution on every record
they touched.
*Why:* History must remain readable after someone leaves.

**BR-063** — A workspace never grants or withholds access. It decides what a
screen leads with, nothing more.
*Why:* Permissions exist for security, workspaces for usability. Confusing them
produces a system that is either insecure or unusable. See `Permissions.md`.

**BR-064** — Every permission is an action *and* a scope (`own` / `team` / `all`).
An action without a scope is not a permission. Where narrowing is impossible or
deliberately not offered, the scope is the sentinel `all` — never absent.
*Why:* "May they read cases?" has no useful answer; "may they read which cases?"
does. Scope is what RLS policies compile down to, and a permission with no scope
would be the one case every policy has to special-case. See ADR-027.

**BR-065** — Every table names the permission governing each of select, insert,
update and delete. A table governed by its parent's permission satisfies this; a
table governed by nothing does not.
*Why:* An unprotected table is not discovered by reading the schema — it is
discovered by an incident. Stated as a rule, it is checkable, and it is checked
by test in `src/domain/permissions/tables.ts`. See ADR-027.

---

## Resolved — archival versus erasure

**Resolved by ADR-018.** BR-003, BR-013, BR-041 and BR-051 say nothing is
deleted; India's DPDP Act gives a right to erasure. The resolution: **personal
data is erasable, the event skeleton is not.** A person redacts to a tombstone
while the fact that a case existed, moved and was lost survives without personal
content. This satisfies every outcome of the legal question, so the schema is no
longer blocked on it.

Two consequences that are now rules elsewhere: event payloads carry no personal
data, only IDs (`Data Model.md` — event); and free-text notes remain a known
redaction leak, since users will type names into them.

**Still genuinely open:** retention periods. Lender record-keeping obligations may
*require* holding documents for years, cutting against erasure. Needs legal
reconciliation, and it constrains policy rather than schema.

---

## Resolved — role partitioning

**Resolved.** A user holds multiple roles and receives the union of their
permissions (BR-061). Interface adaptation is handled by **workspaces**, which are
a usability concept and never an access-control one (BR-063). See `Permissions.md`
and ADR-022.
