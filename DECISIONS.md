# Architectural Decision Record

Every significant decision, with the reasoning that produced it. Newest at the
bottom. Never delete an entry — supersede it, and link the replacement.

Format:

```
## ADR-NNN — Title
Date: YYYY-MM-DD
Status: Proposed | Accepted | Superseded by ADR-NNN
Decision: what we are doing, in one sentence.
Why: the reasoning, including what we gave up.
Consequences: what this makes easy, and what it makes hard.
```

---

## ADR-001 — PRD before code
Date: 2026-08-05
Status: Accepted

**Decision:** No implementation code is written until the PRD documents are
complete and approved.

**Why:** The failure mode for internal tools is not bad code, it is building the
wrong object model. A data model mistake discovered in month six costs more than
the entire design phase. Writing the PRD first also forces the business rules out
of people's heads and onto paper, where they can be argued with.

**Consequences:** Slower start, visibly nothing "working" for a while. In
exchange, the schema and the role model are stable before anything depends on
them.

---

## ADR-002 — AOS is for the loan business only
Date: 2026-08-05
Status: Accepted

**Decision:** AOS covers Amaze Loans Pvt Ltd. Loans. Construction, real estate and
other ventures are explicitly out of scope and are not designed for.

**Why:** Abstraction bought "just in case" is the most expensive kind. A generic
Case-of-any-type model would force vague language and vague screens on the one
business we actually understand, in exchange for a flexibility nobody has asked
for. A loan case has an applicant, documents, banks, and a sanction — we should
name those things directly.

**Consequences:** The vocabulary in schema and UI is concrete: Case means loan
case. If another business line ever needs a system, it gets its own, or this one
gets extended deliberately with the real requirements in hand. We accept that
cost rather than pay for it now.

---

## ADR-003 — Supabase as the backend
Date: 2026-08-05
Status: Proposed

**Decision:** Postgres + Auth + Storage + Row Level Security via Supabase, rather
than a custom API server.

**Why:** Role-based visibility is the single hardest requirement in this product,
and RLS enforces it at the database rather than in application code, where it
would be forgotten. A team this size should not be operating its own auth.

**Consequences:** Permission logic lives in SQL policies and must be tested as
such. Vendor coupling is real but bounded — the data is plain Postgres and can be
exported.

**Open question:** Data residency. Customer KYC (Aadhaar, PAN, ITR) for Indian
borrowers may need to stay in-region. Confirm before this moves to Accepted.

---

## ADR-004 — Case stage and submission status are separate
Date: 2026-08-05
Status: Accepted

**Decision:** A case carries one customer-journey stage. Each bank submission
carries its own independent status.

**Why:** A case submitted to five banks has five different truths at once —
sanctioned at one, rejected at another, pending at three. A single stage column
cannot express that, so the real state would end up in free-text notes, outside
search and reporting. Rejection reasons per bank are also the most commercially
useful data the company will accumulate; they need a structured home.

**Consequences:** Two status concepts to teach users. The UI must show the case
stage prominently and the submission grid immediately beneath it, so the
relationship is obvious rather than explained.

---

## ADR-005 — Events are an append-only log, not the source of truth
Date: 2026-08-05
Status: Accepted

**Decision:** State tables hold current truth. Every state change also appends to
an immutable `event` log, in the same transaction. We are not doing event
sourcing.

**Why:** Timelines, audit, MIS and AI summaries all want an event stream, and
that is achievable with a log. Rebuilding state by replaying events is a much
larger commitment — every read becomes a fold, every bug becomes archaeology —
and it is not maintainable by a small team. We take the benefit and decline the
cost.

**Consequences:** Writes must go through a path that guarantees the paired event.
A state change that skips its event is a bug, and should be prevented at the
database rather than trusted to discipline.

---

## ADR-006 — One person table; roles are relationships
Date: 2026-08-05
Status: Accepted

**Decision:** Customer, employee, referrer and bank manager are not separate
tables. There is one `person`, and roles attach to it.

**Why:** These roles overlap in real life — a customer refers his brother, a
referrer takes his own loan, a bank manager changes banks. Separate tables would
split one human into several records with drifting phone numbers, making "have we
dealt with this person before?" unanswerable. That question is a core reason AOS
exists.

**Consequences:** Every screen must be clear about which role it is showing.
Person deduplication by phone number becomes a critical, permanent piece of the
product rather than an afterthought.

---

## ADR-007 — Documents belong to people and properties, not cases
Date: 2026-08-05
Status: Accepted

**Decision:** A document is owned by the person or property it describes. Cases
reference documents. Only genuinely case-specific paperwork (sanction letter,
login form) is owned by a case.

**Why:** An Aadhaar card belongs to a person, not to a loan application. Hanging
documents off cases forces a repeat customer to re-upload identical KYC for every
loan and creates multiple copies with diverging expiry dates — a direct violation
of "information is entered once".

**Consequences:** A second case for an existing customer opens with KYC already
satisfied. That should be surfaced as a visible win in the UI, not left implicit.

---

## ADR-008 — A lead is a case in an early stage
Date: 2026-08-05
Status: Accepted

**Decision:** No separate Lead entity and no conversion step. Leads are cases in
early stages; dead ones are marked Lost with a reason.

**Why:** Every convert-from-X-to-Y seam produces duplicate records and severed
history. Keeping one object means a case's timeline runs unbroken from first
phone call to disbursement, and lost leads stay searchable and analysable.

**Consequences:** Early-stage cases are numerous and mostly empty. List views
must default to filtering them out, or the case list becomes noise.

---

## ADR-009 — Organisation is a modelled entity from V1
Date: 2026-08-05
Status: Accepted — reverses the position taken in the first Data Model draft

**Decision:** `organisation` and `organisation_alias` exist from V1, covering both
employers and borrowing firms. Users never create one explicitly; typing a name
resolves it in the background.

**Why:** The reporting arguments (find everyone at ABC Textiles, spot repeat
employers) were real but would not on their own have justified the entity —
those are wants, not needs. What settles it is that **for business loans and LAP
the borrower may itself be a firm**, with its own GST certificate, ITR and
financial statements. The entity must exist as a case party regardless, which
makes refusing to use it for employers arbitrary.

Secondary reason: free-text employer names accumulate variants ("ABC Textiles",
"ABC Textile", "abc textiles pvt ltd"). Retrofitting an entity later means
hand-cleaning dirty text across years of records — the expensive class of
migration, and it worsens monthly.

**What was wrong with the original reasoning:** it correctly identified a cost —
users must never be forced to stop and create an Organisation — but treated a UI
problem as a schema problem. Resolve-on-type solves it at the interface layer,
leaving the data structured.

**Consequences:** Organisation matching quality becomes a real feature with real
failure modes (wrongly merging two similar businesses). Near-matches are
suggested, never auto-merged.

---

## ADR-010 — Optional participants generate nothing until they exist
Date: 2026-08-05
Status: Accepted

**Decision:** Co-applicant, guarantor, referrer, employer and property are
optional relationships. An absent participant produces no record, no requirement
row, no placeholder field and no UI section. The only mandatory party is the
primary applicant.

**Why:** Most cases are one applicant and nothing else. Designing for the most
complex representable case makes the common case feel bureaucratic, and it puts
empty sections on every screen, which trains users to skim past screens. Absence
should be silence, not a greyed-out box.

**Consequences:** Adding a participant mid-case is a normal, supported action
that generates new requirements and moves progress backwards. That movement is
shown and explained in the timeline rather than hidden.

---

## ADR-011 — "Not applicable" is distinct from "required but missing"
Date: 2026-08-05
Status: Accepted

**Decision:** Requirements are generated from each case's actual composition, and
progress is computed as `verified / (total − waived − not_applicable)`.

**Why:** A salaried applicant with no co-applicant and no guarantor should reach
100% complete, because nothing about that case is in fact missing. A progress
number that can never reach 100% on a simple case is a number users learn to
ignore — and once ignored, it is permanently useless as a signal. Correctness of
this metric is worth more than its sophistication.

**Consequences:** There is no universal document checklist. Requirement
generation is driven by loan type, applicant profile, party set, property and
target bank, which makes that generation logic a genuinely important piece of the
system and a thing that must be testable in isolation.

---

## ADR-012 — Phone number is the person key; name is never a key
Date: 2026-08-05
Status: **Superseded by ADR-013.** The second half stands — name is never a key.
The first half was wrong: phone is strong *evidence* of identity, not identity.

**Decision:** Primary phone (normalised) is the natural key for a person, with
PAN as a second strong identifier. Names are search and display values only.
Aliases are stored permanently and are searchable.

**Why:** Transliterated Tamil names have no single correct spelling, frequently
have no surname, and reorder initials between forms — the same person is
legitimately "R. Tarun", "Tarun Ramesh" and "Tarun R". Name-based identity would
manufacture duplicates continuously. Phone is the one identifier every customer
has, gives, and remembers.

**Consequences:** Shared phone numbers (commonly husband and wife) will collide
on genuinely different people, so a phone match prompts rather than blocks when
the name disagrees. Phone normalisation and suffix search must be built in from
the start, not added later.

---

## ADR-013 — Identity is a surrogate ID; identifiers are evidence
Date: 2026-08-05
Status: Accepted — supersedes ADR-012

**Decision:** A person's identity is a system-generated Person ID that never
changes and carries no meaning. Phone, PAN, email and Aadhaar are *identifiers*
held in a separate multi-valued table, each with a type, a validity period and a
verification source. Matching combines identifiers into a weighted score; no
single field is identity.

**Why:** ADR-012 confused *how we recognise someone* with *who they are*. Three
failures follow from making phone the identity:

1. **People change numbers.** Under ADR-012 that is an identity change, which
   should be impossible.
2. **Numbers are shared.** One office landline or one family phone would fuse
   distinct people into one record.
3. **India recycles mobile numbers.** A number identifying a customer in 2024 can
   belong to a stranger in 2027, who would silently inherit that person's cases,
   documents and history. This is the dangerous one, and it is not hypothetical.

Identifiers also differ in kind, and the model must know how they differ:

| Identifier | Exclusive? | Strength | Notes |
|---|---|---|---|
| PAN | Yes — one per person | Very strong | Near-definitive when verified from a document |
| Aadhaar | Yes | Very strong | Legally constrained; see open question |
| Phone | **No** — shared and recycled | Strong but time-bound | Requires validity dates |
| Email | Mostly | Medium | Often absent in this market |
| Bank account | No — joint accounts | Medium | Supporting evidence only |

**Consequences:** Recognition becomes a scoring problem rather than a lookup,
which is more code and more testing. In exchange, changed numbers, shared numbers
and recycled numbers all become ordinary cases rather than data corruption. Every
identifier carries `valid_from` / `valid_to`, so a communication logged in 2024
is attributed to whoever held that number in 2024.

---

## ADR-014 — One organisation model, with role extensions
Date: 2026-08-05
Status: Accepted — extends ADR-009

**Decision:** Employers, borrowing firms, builders, developers, vendors **and
banks** are all `organisation` rows. Operational specialisation lives in
extension tables — `lender_profile` for banks, and others only when earned.

**Why:** Consistency with ADR-006, which established the same shape for people:
one identity, roles attached as relationships. Roles genuinely overlap here — a
builder is often also a vendor, and a construction firm can be one customer's
employer and another case's developer. Separate tables would duplicate that firm.

Including banks is the non-obvious part, and it pays immediately: "IIFL" / "IIFL
Home Finance Ltd" / "India Infoline" is the same alias-and-dedup problem as "ABC
Textiles". Treating banks as organisations means alias, fuzzy match, merge and
tombstone-redirect all apply to lenders without building any of it twice.

**Consequences:** The UI must never say "Organisation." Users see Bank, Builder,
Employer — concrete words. The abstraction is a schema fact and stays there. Rows
carry role flags, so every list view must filter by role or it will show banks
in the employer picker.

---

## ADR-015 — Branch is an entity, on operational grounds
Date: 2026-08-05
Status: Accepted

**Decision:** A bank branch is an organisation with a parent link to its bank.
Submissions and bank contacts reference the branch, not just the bank.

**Why:** Not for the reporting reasons originally proposed. At ~10 cases per
month, branch-level statistics on turnaround and approval behaviour would be
noise for years, and publishing them early would be actively misleading — six
cases at one branch supports no conclusion.

The justification that holds today is operational: **a submission physically goes
to a branch, and a relationship manager belongs to one.** The same bank's Madurai
and Chennai branches function as different counterparties for a given file. The
data is structurally cheap to record now and impossible to reconstruct later.

**Consequences:** `organisation` gains `parent_organisation_id`, used **only**
for branch→bank. General organisation hierarchies (parent companies, groups)
remain out of scope until something demands them. Branch performance dashboards
are deferred until volume justifies them, and this ADR should be cited when
someone asks why the data exists but the report does not.

---

## ADR-016 — Loan Product and Bank Product are different entities
Date: 2026-08-05
Status: Accepted

**Decision:** Two entities. `loan_product` is Amaze's own bank-independent
taxonomy (Home Loan → Purchase / Self Construction / Plot Purchase / Balance
Transfer / Top-up; Business Loan → Working Capital / Term Loan / Overdraft /
LAP). `bank_product` is a specific lender's offering, mapped to a loan_product.

**Why:** The two drive different things at different times, and merging them
breaks the requirement engine. Document requirements must be generated **at case
creation**, when the loan purpose is known and no bank has been chosen — banks
are selected late, after documents are collected. A bank-specific product
therefore cannot drive requirements; only the bank-independent taxonomy can.

Split of responsibilities:

- `loan_product` drives document requirements, workflow shape, and reporting by
  business line.
- `bank_product` drives submission rules, rate and amount bounds, and eligibility.

**Consequences:** A mapping between the two must be maintained. It is small and
changes rarely.

**Explicitly rejected for V1:** an executable eligibility rules engine. Products
carry *declarative* metadata and requirement templates, not logic. A rules engine
is a large, permanent maintenance commitment, and bank eligibility criteria change
without notice — an out-of-date engine that confidently returns a wrong answer is
worse than no engine. Revisit only if the same calculation is being done manually
often enough to justify it.

---

## ADR-017 — V1 stores no Aadhaar number
Date: 2026-08-05
Status: Accepted as an interim engineering default, pending legal review

**Decision:** AOS stores the Aadhaar *document image* where operationally
required, with the number masked. It does not store the Aadhaar number as data,
and Aadhaar is not an identifier type in the matching model.

**Why:** The legal question has been open across three review rounds and is
blocking the schema. The risk is asymmetric, so the default should be the
reversible direction:

- If we omit it and counsel later permits storage, adding an identifier type is a
  small migration.
- If we store it and counsel later prohibits it, we have unlawfully held
  sensitive identifiers, and remediation is an incident with statutory exposure
  under the Aadhaar Act, which sharply restricts storage by private entities.

Cost of the conservative choice is modest: PAN is exclusive, near-definitive when
read from a document, and available for essentially all borrowers. The matching
model loses little.

**Consequences:** `Identity Resolution.md` assumes PAN is the strongest available
identifier. If counsel permits Aadhaar later, it enters as one more identifier
type — the model was built to accept it without restructuring.

**Supersede this ADR when legal advice is obtained. Do not quietly widen it.**

---

## ADR-018 — Personal data is redactable; the event skeleton is not
Date: 2026-08-05
Status: Accepted

**Decision:** Personal data lives in columns that can be nulled in place. Events,
stage history and case records hold no personal content and are never deleted.
Erasing a person redacts them to a tombstone; the fact that a case existed, moved
and was lost survives without personal detail.

**Why:** BR-003/013/041/051 ("nothing is deleted") and India's DPDP Act right to
erasure appear to conflict, and lender record-keeping obligations push the other
way. This design satisfies every outcome of that legal question, so it removes the
blocker rather than waiting on it.

It also has to be structural. Retrofitting redaction means finding personal data
scattered through event payloads and free-text notes — effectively impossible to
do completely, and "we mostly deleted it" is not a defence.

**Consequences:** Event payloads must reference people by ID, never by embedded
name or phone. Any denormalised copy of personal data is a redaction leak and is
prohibited. Free-text notes remain a genuine risk, since users will type names
into them; flagged as a known limitation requiring a policy answer.

---

## ADR-019 — Case stage is stored, auto-advanced, and always evented
Date: 2026-08-05
Status: Accepted

**Decision:** Stage is a stored column. Stages 6–8 (Submitted, Sanctioned,
Disbursed) are advanced automatically by submission status changes, with the
system named as actor and the triggering submission cited.

**Why:** Deriving stage on read would make it unstorable, unindexable and
expensive to query — and ambiguous, since "best submission" has no single
definition when one bank sanctions and another rejects. But requiring a human to
manually mirror submission changes guarantees the two axes drift apart, and a
stale stage is worse than no stage.

Storing plus auto-advancing gets one source of truth that cannot drift. Every
movement remains auditable because it is an event like any other.

Auto-advance is one-directional: a rejection never moves a case backwards, since
other submissions may still be live.

**Consequences:** Stage transitions have two classes of actor, user and system,
and the UI must distinguish them so nobody wonders who moved their case. This
corrects `Data Model.md`, which previously cited ADR-005 for stored stage; ADR-005
is about the event log and says nothing about stage.

---

## ADR-020 — Stages express changes of kind; metrics express progress within one
Date: 2026-08-05
Status: Accepted

**Decision:** "Documents Requested", "Documents Received", "Verification Pending"
and "Eligibility Received" are rejected as stages. One `Documents Pending` stage
plus the requirement engine's progress figure replaces the first three; the fourth
is a submission status.

**Why:** Partial receipt is the normal state — four of nine documents in, two
verified. "Received" cannot be answered yes or no, so as a stage it would mean
whatever the last person to touch it thought. `progress = verified / applicable`
says strictly more, precisely, and without human maintenance.

The general rule: a stage marks a change in the *kind* of work happening. Progress
within one kind is a measurement, and measurements do not belong in a state
machine.

**Consequences:** Fewer stages, and the progress metric becomes load-bearing —
it is now the only expression of document-collection status, so its correctness
matters more than before. Reinforces ADR-011.

---

## ADR-021 — On Hold is orthogonal to stage
Date: 2026-08-05
Status: Accepted

**Decision:** Hold is a flag on the case with a reason and a follow-up date, valid
alongside any non-terminal stage. It is not a stage.

**Why:** A held case is still at whatever stage it reached, and when the hold
lifts you must know where to resume. A `On Hold` stage would discard that. Absent
a first-class hold, users will improvise by parking cases in a wrong stage, and
the stage data stops being trustworthy — the failure is silent and permanent.

**Consequences:** Held cases are excluded from "needs attention" until the
follow-up date, which is the operational point: stalled cases stop generating
noise without being forgotten. Every active-case query must account for the hold
flag, so it belongs in shared query helpers rather than being repeated per screen.

---

## ADR-022 — Permissions, roles and workspaces are three separate concepts
Date: 2026-08-05
Status: Accepted

**Decision:** A **permission** is an action plus a scope (`own` / `team` / `all`),
enforced by RLS. A **role** is a bundle of permissions, assigned as runtime data.
A **workspace** is an interface context with no security meaning whatsoever. A
user holds many roles and receives the union of their permissions.

**Why:** Conflating any two produces a system that is either insecure or
unusable. The specific failure avoided: if the interface partitions by role, a
user who is both telecaller and login executive is locked out of half their own
job, and the workaround people reach for is **sharing a login** — which destroys
the audit trail that is the entire point of the system.

Scope must be part of the permission rather than improvised per table: "may they
read cases?" has no useful answer, and RLS policies are precisely a scope
question.

**Consequences:** `user` has no `role` column; roles live in `user_role`. The
permission catalog is defined once in `src/domain/permissions/` and seeded into
`role_permission` by migration — never hand-written in SQL, or the two definitions
will drift. `team` scope is defined but unused in V1, because adding a scope later
means revisiting every policy while leaving one unused costs nothing.

---

## ADR-023 — Terminal stages have no ordinal position
Date: 2026-08-05
Status: Accepted — arose from implementation, no PRD change required

**Decision:** The eight non-terminal case stages are ordered and comparable.
`closed` and `lost` have no position in that order, and the type system prevents
them being used in a stage comparison.

**Why:** Found by the consistency audit. `summariseProgress` accepted a raw
`currentStageIndex: number`, and the natural way to produce one — the position in
the stage array — put `lost` at the highest index. A lost case would therefore
have reported *every* requirement as due, including ones that only become
applicable near disbursement. Nothing failed loudly; the number was simply wrong.

The deeper flaw was the leak: passing a raw index made every caller responsible
for index arithmetic the domain layer should own.

**Consequences:** `progress.summariseProgress` now takes a `CaseStage`, not a
number. Ordinal lookup is internal. Asking whether a requirement is due on a
terminal-stage case returns no applicable requirements, which is the truthful
answer — a lost case needs nothing.

---

## ADR-024 — Case number format and allocation
Date: 2026-08-05
Status: Accepted

**Decision:** Every case carries a UUID primary key and a separate human-readable
case number in the form `AL-YYYY-NNNNN`, sequential within the calendar year,
allocated at case creation, immutable thereafter. The format is a constant in
`src/domain/case/case-number.ts`, not configuration.

**Why, in four parts:**

**The UUID is the identity; the number is for humans.** This is ADR-013 applied to
cases rather than people — a business identifier that anything depends on becomes
a thing that cannot be changed when the business changes. The number is quoted on
the phone and printed on a login form. Nothing joins on it.

**Nothing is encoded in it.** Not loan type, not bank, not branch, not workflow.
Encoded identifiers are a schema in disguise: the moment `AL-HL-2026-00042` exists,
a case whose loan product changes mid-case (a supported operation —
`Workflow.md`) either gets a wrong number forever or gets renumbered, which
breaks immutability. Both outcomes are worse than a meaningless number.

**It is a counter, not a Postgres sequence.** A sequence gaps on every rolled-back
transaction, and a customer quoting `AL-2026-00087` when the company has opened 71
cases invites a question with no good answer. `case_number_sequence(year,
last_value)` is a single row locked per allocation. At ~10 cases a month the
serialisation cost is nil, and the guarantee — contiguous numbers within a year —
is worth more than the concurrency.

**Allocated at creation, including for leads.** ADR-008 makes a lead a case, and
notes early-stage cases are numerous and mostly empty, so this inflates the
number: a company closing 120 cases a year may reach `AL-2026-01500`. The
alternative — allocate on reaching `documents_pending` — was rejected because it
makes the number nullable, and a telecaller on a first call is exactly when a
quotable reference is most useful. A nullable business identifier costs more than
a large one.

**Consequences:** Case numbers are not a count of business done, and any report
that treats them as one is wrong. Year rollover is a new counter row, not a
migration. Search must accept `AL-2026-00042`, `2026-00042`, `00042` and `42`,
which corrects the `#1042` handle in `Identity Resolution.md` Part 6. Backfilling
a differently-formatted historical import would need its own decision; there is no
import today.

---

## ADR-025 — Settings scope: three narrow things, not a settings module
Date: 2026-08-05
Status: Accepted

**Decision:** AOS has no general settings module and no key-value configuration
table. Configurable-without-code-change is achieved by three separate mechanisms,
chosen per kind of thing:

1. **Master data stays entities.** Loan products, banks, branches, bank products
   are tables with foreign keys, aliases and merge behaviour, governed by
   `master_data.manage`. "Settings" would be a UI grouping over them, nothing more.
2. **`document_type` becomes a table.** It is referenced by `document` and
   `document_requirement` and named in `master_data.manage`, but had no entity
   block in `Data Model.md`. It must be a table rather than an enum because
   requirement templates key off it and adding a document type must not be a
   migration.
3. **`operational_threshold` — one narrow table for timings.** Idle threshold per
   stage (`Workflow.md` open question 1), offer-expiry warning lead time,
   unverified-document age, default hold follow-up. Keys are a **closed enum
   defined in `src/domain/settings/` and seeded by migration**; the value is a day
   count.

**Why:** The examples in the brief were four different kinds of object, and the
only way to merge them is a generic `setting(key, value jsonb)` table. That has no
type safety, no meaningful RLS surface, and becomes the place things go when
nobody wants to model them properly.

The `operational_threshold` shape is deliberately the same pattern as the
permission catalog (ADR-022): the enum of keys lives in TypeScript and the
database is seeded from it. You cannot add a key without a code change. That is
the property that stops it becoming a dumping ground, and it is the difference
between a lookup table and a configuration system.

**Explicitly not configurable: the case number format.** A format setting is
precisely the mechanism by which someone encodes loan type into the case number in
eighteen months, with no ADR and no review. See ADR-024.

**Consequences:** Adding a new tunable timing is a small code change plus a
migration, not a settings screen entry. That is the intended friction. If the same
kind of constant is being added repeatedly, revisit — but a generic table should
be the conclusion of that evidence, never its premise.

---

## ADR-026 — Sensitive columns are masked in views; RLS is row-level only
Date: 2026-08-05
Status: Accepted

**Decision:** One mechanism, applied identically everywhere. Row visibility is RLS
on the base table. Column visibility is a **masked view**, and application clients
read the view, never the base table. Both consult one SECURITY DEFINER function,
`app.has_permission(action, scope)`, which is the only reader of `user_role` and
`role_permission`.

Two permissions are column-level and no others: `identifier.view_full` (unmasked
PAN and similar) and `commercial.view` (commission terms, referrer payouts, login
fees, invoice figures).

**Why:** Postgres RLS filters rows. `identifier.view_full` and `commercial.view`
hide *columns* on rows the user is otherwise entitled to see, so they cannot be
policies. Column `GRANT`s are the other native option, but they are role
privileges and do not compose with the `role_permission` table that ADR-022 makes
authoritative — the permission model would then live in two places with different
semantics, which is the failure ADR-022 exists to prevent.

Masked views keep one authority. The mask is an expression
(`CASE WHEN app.has_permission(...) THEN raw ELSE masked END`), so the same table
serves both audiences without duplicating rows or policies.

**Consequences, including one the PRD has to give up:**

Base tables are revoked from client roles. Every read path goes through a view,
which means views are part of the schema contract and must be migrated in step.
Writes go to base tables through the domain layer, which is where they belonged
anyway.

`Permissions.md` claims a denied attempt at a sensitive permission writes an
event. Under masking there is no attempt and no denial — you receive a masked
value and nothing happens. That claim is narrowed to `identifier.view_full`, the
only one that is a per-record disclosure decision rather than a whole-surface one:
`app.reveal_identifier(identifier_id)` is the sole path to a full value and always
writes an event, granted or denied. For `commercial.view` and `event.view`,
"denial" is simply absence from a screen, and inventing an event for it would mean
logging every page load.

---

## ADR-027 — Every table has a permission model; every permission has a target
Date: 2026-08-05
Status: Accepted — extends ADR-022

**Decision:** The permission catalog is derived from the entity list rather than
accumulated from screens. Three things are now stated once, in
`src/domain/permissions/`, and checked by tests:

1. **Every permission carries a scope, always.** Where narrowing is impossible —
   `case.create` has no row to scope — the scope is the sentinel `all`. This makes
   BR-064 literally true and keeps every check a single ordered comparison
   (`all` ⊇ `team` ⊇ `own`) rather than a special case per permission.
2. **Every table names the permission that governs each operation.** Tables with
   no permission of their own bind to their parent's — `case_party` is governed by
   `case.read` / `case.update` — which is a permission model, not an absence of
   one. A table with no binding is a test failure.
3. **`own` has one definition per scope family, not per table.** Three families:
   *case-derived* (`own` = attached to a case you own or are a named participant
   on), *reference* (`own` is meaningless; these are read at `all` by everyone and
   written under `master_data.manage`), and *self* (`user` reading its own row).

**Why:** The audit found `property`, `employment`, `communication.read`,
`note.read` and `organisation.update` simply missing, and `Permissions.md` closed
with the prose wildcard "all read permissions at `all`" for Admin — ambiguous on
the one entry that matters, `identifier.view_full`. Both are symptoms of the same
thing: the catalog grew from the screens someone had thought about.

`own` was the sharper problem. It was defined as "the owner, or a named
participant", which is computable for `case` and meaningless for `document` — a
document belongs to a *person* (ADR-007), and that person's KYC is referenced by
cases owned by three different people. Left unresolved, each policy author would
have invented an answer at the moment of writing.

**Consequences:** Admin's grant is enumerated, and excludes `identifier.view_full`
and `commercial.view` — administering the system is not a licence to read
customers' PANs. Adding a table without a policy binding fails the test suite
rather than shipping an unprotected table. The case-derived `own` predicate reaches
into `case_party`, so it is on the hot path of nearly every read and is indexed
deliberately rather than incidentally.

**Left open, deliberately:** whether Login Executive holds `case.update` at `own`
or `all` was decided here as `all`, on the grounds that a desk holding
`document.verify` and `submission.create` at `all` scope but unable to correct the
requested amount on the file it is submitting is incoherent. Flagged rather than
buried: this is the one grant in the matrix chosen by the engineer rather than
stated by the business.

---

## ADR-028 — Bank rejection reasons are master data, in two layers
Date: 2026-08-05
Status: Accepted

**Decision:** Rejection reasons are **not** an enum. `rejection_reason` is a
first-class master-data table — `code`, `name`, `description`, `active`,
`display_order` — seeded with an initial set and maintained under
`master_data.manage`.

Every rejection records **two** things:

1. `rejection_reason_id` — Amaze's own standardised category. Mandatory (BR-024).
2. `bank_reason_text` — what the bank actually said, verbatim. Optional.

**Why the two layers are the whole point.** Banks describe the same refusal in
incompatible language: one writes "FOIR exceeded", another "obligations high",
another "IIR norms not met". All three are one fact. Storing only the bank's
wording makes the dataset unanalysable — and rejection reasons are the most
commercially valuable data the company will accumulate (ADR-004). Storing only
our category loses the evidence, and when someone later disputes how a rejection
was classified there is nothing to check the classification against.

So: the category is what reports group by, and the verbatim text is what proves
the category was chosen honestly.

**Why master data rather than an enum.** The list will change without warning as
new lenders join the panel with new vocabulary, and it will change on a
timescale of weeks. An enum makes each addition a migration and a deploy, which
means in practice people will pick the nearest wrong value instead — silently
corrupting the one dataset this table exists to protect. `document_type` became a
table for exactly this reason (ADR-025).

**Why `lost_reason` stays code-defined, and this is not an inconsistency.** The
dividing line is whose vocabulary it is. Lost reasons are *Amaze's* view of why a
customer walked away; the list is stable, small, and changing it is a business
decision worth a code review. Rejection reasons must absorb *other
organisations'* vocabulary, which nobody at Amaze controls. Our vocabulary lives
in code; the world's vocabulary lives in data.

**What was rejected:** a per-bank catalog of that bank's own reason codes,
mapping each to a category. It is the more correct model and it is premature —
we do not have any bank's taxonomy in hand, and building the mapping table before
there is anything to map produces an empty table plus a screen nobody fills. The
verbatim text captures the same information losslessly; when a year of it exists,
the common phrasings per bank can be promoted into a mapping table without any
data being lost, because it was recorded.

**Consequences:** A rejection cannot be recorded without a category, which is
mild friction at exactly the right moment. Retired reasons are deactivated, never
deleted, so historical submissions keep pointing at the category they were
classified under. The seeded list is a starting point and is expected to be
revised once real rejections accumulate — revising it is a data change, which is
the entire benefit.

---

## ADR-029 — `reference` is the family where `own` is not offered; write governance is a separate axis
Date: 2026-08-05
Status: Accepted — extends ADR-027

**Decision:** ADR-027's `reference` scope family means exactly one thing: **`own`
is not offered on this table, so every permission on it permits `all` alone.**
Which permission governs *writing* is an independent property, stated per table.

This puts two kinds of table in one family:

- **Master data** — loan products, bank products, document types, rejection
  reasons, thresholds, lender profiles. Written under `master_data.manage`.
- **The directory** — `person`, `organisation`, `property`, `employment` and
  their satellites. Written under their own create / update / merge permissions.

**Why this needed saying.** ADR-027 defined `reference` as "read at `all` by
everyone and written under `master_data.manage`". Deriving the matrix showed that
`person` matches the first half and contradicts the second: `person.read` is held
at `all` by every role — a telecaller who cannot discover that the caller is an
existing customer has lost the product's central promise (Principle #4) — but
people are created by telecallers, not by administrators.

Under the original wording `person` fitted no family, and `own` was therefore
undefined on the most-read table in the system. The two available fixes were a
fourth family, or recognising that read-scope and write-governance were conflated
in one definition. The second is smaller and truer: the family exists solely to
define `own`, and `own` is equally absent from both kinds of table.

**Why `own` is not offered on these tables at all, rather than defined-but-ungranted.**
It *is* computable — a person is reachable through `case_party`, a property
through `case_property`. Defining a predicate that nothing uses invites someone
to grant it later without reading why it was never granted, and the transitive
reachability (organisation → employment → person → case_party → case) is
expensive and easy to get subtly wrong. The catalog therefore permits `all` only,
and a test enforces it. If narrowing is ever genuinely wanted, the predicate is
designed at that point with a reason on the table.

**Consequences:** `document` stays `case-derived` and is the one sensitive
artefact that *is* narrowable — which is the right asymmetry, since a document is
the thing a customer would mind being read. Master data and the directory share
one RLS shape for reads (`true` for any authenticated user) and differ only in
their write policies, which is less policy code than three families would have
been.

---

## ADR-030 — Master Data Engine: which vocabulary became a table, and which stayed an enum
Date: 2026-08-06
Status: Accepted

**Decision:** Eight tables were added under the shared shape ADR-025 and
ADR-028 established (`code`, `name`, `description`, `is_active`,
`display_order`, `effective_from`, `notes`): `loan_category`,
`employment_type`, `business_constitution`, `property_type`,
`property_ownership_type`, `referral_source`, `district`, `city`
(Database/migrations/0012, 0013). Every consuming table gained a nullable
foreign key alongside its existing free-text or enum column — additive, never
a rename or a drop.

**What each conversion fixes, specifically:**

- **`loan_category`** promotes `loan_product.category`, previously free text
  with no controlled vocabulary, to a real taxonomy. `loan_product` keeps
  `category` for now; the column's retirement and the product catalogue's own
  management screen are the "Loan Product Catalogue" milestone, not this one.
- **`employment_type`** converts `app.employment_type` from an enum (0001) to
  a table. This is the one place 0001's own enum/table line — "table if
  requirement templates key off it" — was drawn wrong: employment type drives
  requirement generation exactly as `document_type` does, and a lender panel
  adding "NRI" or "Pensioner" is a data change, not a code review. The enum
  stays for backward compatibility.
- **`business_constitution`** fills a gap: a borrowing firm (ADR-009) had no
  field at all for how it is legally constituted, which a business loan or LAP
  file needs.
- **`property_type` / `property_ownership_type`** replace two `property`
  columns that have been free text since 0003 with no structure whatsoever —
  the exact duplicate-vocabulary risk ("Apartment" vs "Flat") master data
  exists to prevent.
- **`referral_source`** replaces a hardcoded `<option>` list literally written
  into `Frontend/src/screens/NewCase.tsx` — the clearest instance in the
  codebase of the pattern this milestone exists to remove, a business value
  that could not be added without shipping code.
- **`district` / `city`** give Amaze's operating footprint a controlled
  vocabulary for the first time. Deliberately **not** wired into
  `person.city` / `organisation.city` / `property.city`, which stay free text:
  those three columns carry real data across the whole schema, and matching
  it against a new master list is a migration and a UI decision in its own
  right, not something to fold into the milestone that establishes the
  pattern. The tables exist and are ready for that follow-up.

**What deliberately did not convert, and why:**

- **Banks, NBFCs, HFCs, branches** were already master data before this
  migration, via `organisation` (roles, ADR-014) and `organisation.parent_
  organisation_id` for branch → bank (ADR-015). `lender_type` (bank/nbfc/hfc)
  stays an enum — three fixed regulatory categories, not a business list.
  Their administration screen is the "Coimbatore Bank & NBFC Catalogue"
  milestone; this one only confirms the underlying data was already correctly
  shaped.
- **`document_type` and `rejection_reason`** were already tables (ADR-025,
  ADR-028) but had no admin UI at all — the frontend prototype hardcoded them
  in seed data with no way to add or deactivate one. Milestone 5 gives both an
  admin screen, and extends their frontend types with the `is_active` /
  `display_order` / `description` fields the database already had.
- **Case stage, submission status, requirement status, lost reason, case
  party/property role, scope, role, identifier type, verification source,
  alias source, document owner kind, communication channel/direction, event
  actor kind/source** all stay enums. Every one of these is workflow or
  structural vocabulary that Amaze owns and where a new value is a genuine
  code-and-review decision — a new case stage changes the state machine in
  `src/domain/case`, not a dropdown. This is exactly the line ADR-028 already
  drew between `lost_reason` (enum, Amaze's own view) and `rejection_reason`
  (table, must absorb the world's vocabulary).

**Consequences:** A new admin screen, `Frontend/src/screens/MasterData.tsx`,
gives office staff one consistent, searchable place to manage all ten tables
(the eight new ones plus document types and rejection reasons), gated by the
existing `master_data.read` / `master_data.manage` permissions — no new
permission was needed, because ADR-027 already required every reference table
to answer to those two. Records are deactivated, never deleted, matching every
other reference table in the schema. Every new table is bound in
`src/domain/permissions/tables.ts` and enabled for RLS in its own migration,
so the `schema-coverage.test.ts` contract (ADR-027) holds without editing
`0010_security_defaults.sql`.

---

## ADR-031 — Master data has three display categories; geography starts at Coimbatore
Date: 2026-08-06
Status: Accepted

**Decision, part one — geography.** The demo geography seeded in 0013
(Madurai, Chennai, Mumbai) is deactivated, not deleted, and replaced with
Amaze's actual footprint: Coimbatore, Tiruppur and Erode districts, and ten
named towns (Database/migrations/0014). No schema change was needed —
`city.district_id` and `district.state` (free text, added in 0012) already
give a three-level hierarchy with no ceiling on how many states it can hold.
Covering Kerala, Karnataka or the rest of India later is purely more `insert`
statements, which is the property this milestone asked for and confirms
ADR-030's design already had.

**Decision, part two — hierarchy.** Every master-data section in the admin
screen is grouped into one of three categories, each with a stated character:

- **System Master Data** — rarely changes, administrator-level reference
  data. Document Types, Employment Types, Business Constitutions, Property
  Types, Property Ownership Types, Rejection Reasons, Districts, Cities.
- **Business Master Data** — business-controlled, defines Amaze's lending
  ecosystem, changes occasionally. Loan Categories and Referral Sources are
  editable here today; Loan Products, Banks, NBFCs, Housing Finance
  Companies and Bank Branches already exist in the schema (`loan_product`,
  `organisation` + `lender_profile`, ADR-014/015/016) and are listed as
  planned, read-only entries pointing at the milestone that will give them a
  screen.
- **Operational Master Data** — frequently-changing business entities:
  Employees, Relationship Managers, Builders, Developers, Advocates, Legal
  Firms, Chartered Accountants, Valuers, DSAs, Referral Partners. None are
  editable master data yet, listed for the same reason as above.

**Why geography sits under System, not its own category.** The milestone
brief's three category lists do not mention geography at all. System Master
Data's own description — "rarely changes, administrator-level reference
data" — fits city and district exactly: nobody at Amaze expects a new town to
appear often, and adding one is an administrator's job, not a lending
decision the way a new loan category or referral channel is.

**Why the category is a display grouping, not a schema concept.** The same
reasoning as `PERMISSION_GROUPS` in `src/domain/permissions/actions.ts`
("documentation grouping only, carries no behaviour"): a `category` column on
every master-data table would be a structural change the brief explicitly
ruled out, for a fact that is true of the *table*, not of any individual
*row*. The category is declared once per section in `MasterData.tsx` and nets
out to a UI grouping, not a data model.

**Why Operational entities are listed but not built.** Milestone 5 already
established that a person or organisation playing a role (referrer, bank
contact, builder) is a *relationship*, not a code/name vocabulary row — a
Relationship Manager is a person with a branch relationship (ADR-006,
ADR-014), and forcing it into the MasterDataRecord shape would misrepresent
what it is. Building dedicated operational-entity tables for the ones with no
home yet (Advocates, Legal Firms, Chartered Accountants, Valuers, DSAs,
Referral Partners) is new schema work belonging to its own milestone, which
this one's brief explicitly asked to avoid ("design their place in the
hierarchy without implementing unnecessary complexity").

**Consequences:** The admin screen gains a top-level System / Business /
Operational tab bar; each tab's left-hand nav lists only the sections
implemented for that category, with a read-only panel underneath naming what
else belongs there and why it isn't editable yet. Office staff seeing an
empty Operational tab are told where that data already lives (`app_user`,
`bank_contact`, `organisation` roles) rather than shown nothing. No new
permission, no new table, no new domain module — same conclusion Milestone 5
reached for master data generally, now extended to its own presentation.

## ADR-032 — Lending products are a catalogue, not a taxonomy; three layers, kept separate
Date: 2026-08-06
Status: Accepted

**Decision.** `loan_product` stops being a two-column taxonomy (category +
variant, free text since 0003) and becomes AOS's description of what Amaze
lends against: a name, a description, a security type, borrower / employment
/ business eligibility, property and GST requirement, typical tenure and
amount ranges, and lifecycle dates (Database/migrations/0015). Three layers
are modelled separately and named separately:

- **Loan Category** — Amaze's commercial grouping. "Business Loans." Master
  data since ADR-030.
- **Lending Product** — what Amaze actually arranges, bank-independent.
  "Working Capital Facility (Cash Credit)." This ADR.
- **Bank Product** — one lender's version of it. "HDFC Smart Business Loan."
  `bank_product`, since 0003, unchanged here; its own screen is the Bank &
  NBFC Catalogue milestone.

**Why the middle layer is the load-bearing one.** It is the finest-grained
thing that is known at case creation, before any bank is chosen. A bank
product cannot drive document requirements because banks are selected late
(ADR-016). A loan category is too coarse — "Business Loan" does not tell you
whether a property is involved. Collapsing the three into one table, which
the two-column taxonomy effectively did, is what would make the Document
Requirement Engine impossible to build from data rather than from `if`
statements on product codes.

**Why eligibility is many-to-many junctions, not columns.** A LAP is
available to a salaried employee AND a self-employed professional AND a
business owner. A column forces one; a comma-separated text column forces
every reader to parse it, which is the vocabulary drift ADR-030 existed to
remove. Three junction tables (`loan_product_borrower_type`,
`loan_product_employment_type`, `loan_product_business_constitution`) reuse
the master data Milestone 5 already created rather than inventing parallel
vocabularies — reuse was the return on having built the Master Data Engine
first. These junctions are the one family of tables in this schema where
`delete` is permitted: a junction row carries no history of its own, the fact
of record is the product, and the edit is already in the event log (ADR-005).

**Why three new master-data tables and not six.** `borrower_type` and
`security_type` are genuinely new vocabulary. Property requirement and GST
requirement share ONE table, `requirement_applicability` (mandatory /
optional / not applicable), because they ask the same question about
different things and two identical three-row tables would be two places to
get one answer wrong. Employment and business eligibility create no tables at
all — they reuse `employment_type` and `business_constitution`.

**Why `borrower_type` is not a duplicate of `business_constitution`.** The
constitution table answers "how is this firm legally constituted?"
(proprietorship, partnership, private limited) and is reused unchanged.
Borrower type answers the coarser question a product asks first — is the
borrower a person or a firm, and does residency change the product? An NRI
Home Loan and a resident Home Loan are different products with different
documents, which is why residency belongs on this axis and nowhere else.

**Why the ranges are declarative and must stay that way.** Tenure and amount
are TYPICAL market ranges, guidance for an office user, never a rule. The
binding figures are per lender, on `bank_product`. This is ADR-016 restated:
an out-of-date engine that confidently returns a wrong answer is worse than
no engine. `@domain/products` therefore does lifecycle and selection — is
this product offerable, which products match what the user typed — and
deliberately does not answer "will this customer qualify?".

**Revision and retirement, designed and not built.** Retirement is
`is_active = false` plus `effective_to`. Revision is a new row with its own
code, `supersedes_loan_product_id` pointing at the old one, and the old one
retired; `supersededCodes` in the domain layer inverts the arrow for readers
who want it forwards. Neither flow has a screen. The columns exist so the
first one is data entry rather than a migration, which is the same bet 0012
made and won.

**Backward compatibility.** Additive throughout. `category` and `variant`
keep their names, types and NOT NULL, and every row the catalogue writes
still populates them, so anything reading the old pair sees a complete table.
`name` and `loan_category_id` are what new code reads. The text pair is
retired when nothing reads it, which is not this milestone.

**Consequences.** The Document Requirement Engine can key templates off
product attributes (needs a property? expects GST?) instead of branching on
product codes in TypeScript, which is the branch that exists in
`Frontend/src/fake/requirements.ts` today and is the next thing to remove. A
future Eligibility Engine, Bank Catalogue, reporting cut by product, and AI
product recommendation all read this table and need no schema change to do
it. The cost is a screen with more fields on it than a master-data row has,
which is why the catalogue got its own screen rather than becoming an
eleventh section on the Master Data one.

## ADR-033 — Lending Product refinement: rename, not rebuild; a three-state lifecycle; guidance columns kept declarative-free

Date: 2026-08-06
Status: Accepted

**Decision.** Milestone 7.1 refines the catalogue ADR-032 created, without
redesigning it. Three changes, all additive:

- **`loan_category` renamed to `customer_product`.** No new table.
  `loan_category` already modelled exactly what a telecaller calls a
  "Customer Product" — Home Loan, Business Loan, LAP — grouping several
  lending products underneath it (Home Loan groups Purchase, Self
  Construction, Balance Transfer, Top-up, NRI...). The milestone brief asked
  to "separate Customer Products from Lending Products... do not duplicate
  data" — the separation already existed in ADR-032's three-layer hierarchy;
  duplicating it into a second table would have been the mistake the brief
  warned against. Renaming is the whole change (Database/migrations/0017): a
  plain `ALTER TABLE ... RENAME`, no data moved, every id and foreign key
  intact. `loan_product` keeps its name — it was already the "Lending
  Product" layer ADR-032 named — and `bank_product` is untouched and stays
  independent, as the brief asked.

- **Active/Inactive becomes a three-state `availability_status`**: `active`,
  `temporarily_suspended`, `retired`. A lender pausing a scheme is a
  different fact from Amaze retiring a product for good, and a boolean could
  not say which. Kept as a plain text column with a check constraint, not a
  new master-data table: this is fixed, three-value operational vocabulary
  tied to code (the domain layer's lifecycle logic), the same reasoning
  0012's closing summary used to keep `case_stage` and its siblings as enums
  rather than master data — a business user does not get to invent a fourth
  lifecycle state without a code and workflow review. `is_active` is kept,
  unchanged in name and type, and pinned to the new column by a check
  constraint (`is_active = (availability_status = 'active')`) so the two can
  never drift apart — every existing reader that only knows `is_active` still
  gets the right on/off answer, satisfying the brief's explicit backward
  compatibility instruction for this part.

- **`typical_customer_profile` and `typical_documents_summary`**, both free
  text. Deliberately NOT structured data, on the brief's own instruction:
  "this is guidance only... later milestones will generate exact requirements
  automatically." Neither column is read by the borrower_type /
  employment_type / business_constitution eligibility junctions ADR-032
  created, which remain the one declarative source of truth about who may
  actually take a product. A human reads these two columns; no engine does.

**Why a migration and not just a UI relabel.** The brief's own examples
("Home Loan → Purchase, Self Construction...") describe the schema
`loan_category`/`loan_product` already implements. A cosmetic-only relabel
would leave the database calling something a "Loan Category" that every
office conversation calls a "Customer Product," which is exactly the
kind of naming drift the Master Data Engine milestone (ADR-030) existed to
prevent. The rename is cheap (no data movement) and keeps the schema's
vocabulary matching the business's.

**Coimbatore-first, kept out of the schema.** The brief's Part 5 (prioritise
products the Coimbatore ecosystem actually uses) is entirely seed data and
UI ordering — `customer_product.display_order` and a handful of description
edits naming local industries (Database/migrations/0018) — not a schema
change. No product was invented or removed.

**Consequences.** The Document Requirement Engine (still a future milestone)
gains nothing new to read from this migration — it already had everything it
needs from 0015. What changes is entirely legibility: the catalogue's names
match how Amaze's own staff describe it, a suspended product is
distinguishable from a retired one, and a telecaller can see who a product is
usually for and what it usually asks for without waiting for the requirement
engine to exist.

---

## ADR-034 — The lender catalogue extends the organisation model; institutional knowledge is stored separately from rules

Date: 2026-08-06
Status: Accepted

**Decision.** Milestone 8 builds AOS's lender intelligence layer by deepening
four tables that already existed and adding three that did not. Nothing about
the organisation model changes.

| Concept | Where it lives | New in Milestone 8 |
| --- | --- | --- |
| Institution | `organisation` (role `lender`) + `lender_profile` | Eleven columns on the extension |
| Branch | `organisation` (role `branch`) + `bank_branch` | The extension table |
| Relationship Manager | `bank_contact` | Institution, role, work contact, notes |
| Supported Products | `bank_product` | Notes and audit columns only |
| Submission Rules | `lender_submission_rule` | New, declarative |
| Lender Profile | `lender_insight` | New, guidance only |

**Why not a `bank` table.** The obvious reading of "create a catalogue of
lending institutions" is a new entity. ADR-014 already refused that, and the
reason has not weakened: "IIFL" / "IIFL Home Finance Ltd" / "India Infoline"
is the same alias-and-dedup problem as "ABC Textiles," and a separate bank
table means alias, fuzzy match, merge and tombstone-redirect are all built
twice — or, more realistically, built once for borrowers and never for
lenders, at which point the catalogue accumulates three HDFC Banks. The
milestone's own seed proves the point twice over: HDFC Ltd merged into HDFC
Bank in July 2023, and "HDFC Home Loans" is an alias rather than a second
institution.

**`app.lender_type` becomes master data.** The enum has three values —
`bank`, `nbfc`, `hfc` — and the brief asked for seven with room for more. A
Small Finance Bank is not an engineering distinction from a Public Sector
Bank; it is a business one, it changes what a case is worth routing there,
and the list grows (payments banks, microfinance institutions, fintech
lenders) on a timescale of months. That is ADR-030's test for table-over-enum
and the enum fails it. The enum column is kept and kept populated, widened
rather than falsified — a Small Finance Bank is recorded there as a `bank` —
so every pre-Milestone-8 reader keeps working. Same pattern as
`loan_product.category` in ADR-032.

**`bank_contact.branch_organisation_id` becomes nullable, and the institution
becomes required.** A regional or state-level relationship manager belongs to
a lender and to no single branch, and refusing to record one would push the
most senior contacts out of the system entirely. The backfill runs before the
constraint changes, so every existing row keeps the branch it had and no
existing reader sees a null it did not see before. Work mobile and work email
sit on `bank_contact`, deliberately not on `person_identifier`: a person's own
phone is their identity and follows them for life, while a desk number and a
bank email address belong to the posting and die with it — storing them as
identifiers would leave a dead @hdfcbank.com address on a human being's
identity record for ever and quietly make it a matching signal (ADR-013).

**Submission rules are declarative and named as a hazard.** The office calls
them rules, so the table is called `lender_submission_rule` — and both the
table comment and the permission binding say in as many words that nothing in
AOS may ever execute one. Calling it something safer would have hidden the
risk rather than removed it. It records how a file is lodged and what to
carry; the submission workflow milestone still reads `submission` (0006).

**The lender profile: experience stored apart from criteria.** The most
valuable thing an experienced loan team knows does not fit in fields.
"Excellent for textile businesses." "Responds quickly to MSME manufacturing
cases." "Very strict on GST compliance." "Often asks for an extra year of
ITR." "The RM prefers WhatsApp before email." Today that lives in two
people's heads.

`lender_insight` stores it as categorised, dated free text attached to an
institution or a branch, and the separation from `lender_profile`'s own
columns is the decision, not an implementation detail:

- A lender's stated criteria and the office's lived experience of it are
  different kinds of claim with different reliability, and a schema that
  interleaves them makes the difference unrecoverable.
- The category is what keeps that visible downstream. "Known limitation" and
  "process tip" must never read the same to a person or to an assistant, and
  they cannot if the category travels with the note.
- `observed_on` exists because experience ages. A note about a manager who
  transferred last year is worse than no note; a reader who can see the date
  can discount it.
- When AI features arrive, these are **context to quote, never conditions to
  evaluate** — "the team notes that this lender is strict on GST compliance,"
  not "this lender requires GST compliance." ADR-016's warning about
  confidently wrong answers applies with more force here than anywhere else
  in the schema, because an insight is honest about being one person's
  experience and a rules engine is not. `body` is not parsed, matched or
  branched on by `@domain/lenders`, and must not be by anything downstream.

**What was seeded, and what was refused.** Real institutions with real head
offices; Lakshmi Vilas Bank inactive with the amalgamation noted; branches
carrying district and city and nothing else. No relationship managers, no
phone numbers, no addresses, no turnaround days, no rates, no limits, no
insights. `Frontend/src/fake/lenders.test.ts` asserts each of those absences,
so a later "7 days" that nobody measured fails the build rather than becoming
fact by repetition.

**Consequences.** Case Routing, Eligibility Suggestions, Submission Tracking,
Turnaround Analytics, AI Recommendations and Reporting all now have a layer to
read, and each remains its own milestone — none is started here. Adding a
lender, a branch, a manager, a supported product, a submission note or a piece
of hard-won experience is data entry on one screen; adding a *kind* of lender,
role, submission mode or note category is a row in master data. Neither needs
a developer. What stays hard, deliberately: getting AOS to decide anything
about a lender. That is the next argument to have, and this milestone is the
evidence it will need.

---

## ADR-035 — Document requirements are rules, not code; the situation is the unit, not the product

**Status.** Accepted, Milestone 9.
**Schema.** `Database/migrations/0021`, `0022`.
**Code.** `src/domain/requirements/rules.ts`, `default-rules.ts`,
`document-catalogue.ts`. **Guide.** `Docs/Document Requirement Engine.md`.

**The problem.** Until this milestone, what AOS asked a customer for lived in
`if` statements: a `KYC` array, a `SECURED_PRODUCTS` set, one branch per
product. Three consequences, each worse than the last. A new lending product
meant a code change and a deploy. The office could not *see* the checklist,
let alone change it — which meant the people who actually know what a bank
asks for had no way to correct the system that asks on their behalf. And the
checklist was necessarily crude, because a hand-written branch cannot express
"a partnership borrowing working capital, registered under GST, with a
property offered" without collapsing under its own nesting.

**The decision.** Every document requirement is generated from a structured,
editable rule row. There is no hardcoded checklist left anywhere in the
application.

**Why not a `loan_product` → `document_type` junction table**, which is what
0015 left room for and what most systems build. Because a rule is not "a
document this product needs." It is "a document this SITUATION needs," and a
situation is a conjunction: product AND employment type AND constitution AND
whether a property exists AND whether GST applies AND how far construction has
got. A two-column junction can express none of that. Systems that start with
one end up with a `notes` column full of conditions nobody can query, and a
developer back in the loop within a year. The unit had to be the situation.

**The shape.** One rule names a document type, a scope (case, party or
property), how strongly it is wanted, the stage it becomes due, how many
trailing financial years of it, and zero or more conditions over a closed list
of facts. Zero conditions means unconditional — PAN, for every individual who
signs.

**Scope is what makes ADR-010 automatic rather than enforced.** A party-scoped
rule is evaluated once per party who actually exists, so a case with no
guarantor never enters the guarantor branch and generates no guarantor rows —
not rows marked N/A. Absence is silence, as a property of the design rather
than as a check somebody has to remember. The same holds for property rules,
which is the whole "collateral dependency" the brief asked for, for free.

**The facts list is closed, and three of them are three-valued.** Closed
because a rule editor has to offer a business user a dropdown of what can be
asked, and "any string" is not a dropdown; adding a fact is the point at which
a developer *should* be involved, because a new fact means new data to capture.
Three-valued because `is_gst_registered`, `has_existing_obligations` and
`construction_stage` are nullable and stay nullable: null is "nobody has asked
yet", which is not false. The `is_true` / `is_false` operators exist so that an
unanswered question never silently generates — or silently suppresses — a
requirement. A system that treats unanswered as no is a system that quietly
stops asking for things.

**Merging takes the stricter reading, always.** Two rules can legitimately land
on the same document for the same subject — a bank statement is asked for by
the salaried income rule and again by the business-banking rule, for someone
who is both. Mandatory beats optional, the earlier stage wins, the longer
financial-year window wins. The alternative lets adding a rule quietly weaken
an existing one, which is precisely the failure that makes people stop trusting
a rules engine and start keeping their own list.

**The evaluator is pure and holds no database.** Facts in, requirements out;
same inputs, same answer, every time. That is what lets the whole engine be
tested without a database, and what keeps the prototype and the server from
diverging — the invariant this repository has held since ADR-001. Everything
needing a database (resolving ids to codes, expanding financial years,
preserving what has already been collected) lives in an adapter around it.

**Two things it decides nothing about, deliberately.** It never decides whether
a case is approvable — ADR-016's warning about confidently wrong answers is not
weakened here, only kept out of scope. And it never reads a document; OCR is a
later milestone that will *satisfy* these requirements, not generate them.

**Editing a rule does not rewrite open cases.** A rule change can touch
hundreds of live files, and an admin screen that silently rewrote them all is
how a system loses the trust it needs to be useful at all. Each case picks the
change up the next time anything on it changes, or on an explicit
"re-evaluate" that somebody has decided to press.

**Rules are deactivated, never deleted** — BR-027's discipline, applied where
it matters most. A requirement generated two years ago names the rule that
asked for it, and "why was this document collected?" has to stay answerable
after the rule is retired. `applicability = not_applicable` records that a rule
was switched off on purpose; `is_active = false` records that it is out of
service. Business users mean different things by the two, so both are offered.

**Two new concepts on the requirement itself.** `rejected` completes the status
set: a refused upload used to fall back to `pending`, which loses the fact that
a human already spent time on it and told the customer why. And `applicability`
distinguishes optional requirements — listed, collected and verified like any
other, but excluded from progress arithmetic, because an optional document
nobody chased must not be able to hold a complete file at 94%.

**Case-party overrides rather than editing the person.** Employment type,
borrower type and business constitution can be set per case party. A case
screen that rewrote a shared person record to change one case's checklist would
corrupt every other case that person is on — and "underwritten as salaried on
this file, as a business owner on that one" is two facts, not one fact that
keeps changing.

**What was seeded, and with what confidence.** Eighty-six rules and fifty-one
new document types, researched against published Indian lender and NBFC
checklists and Tamil Nadu registration practice: the three-way income split,
constitution-driven business paperwork, the Tamil Nadu property core (patta /
chitta, parent document, encumbrance certificate, DTCP layout approval), and
security-documented products where no income proof is asked at all. These are
**market norms, not any lender's policy**, and every one is a row a business
user can change. The alternative — shipping an empty rule table and asking
someone to type ninety rules on day one — produces a system nobody configures,
and a blank checklist is worse than an imperfect one.

**Consequences.** Adding a document to a product is data entry. Adding a
*kind* of document is a master-data row. Adding a new fact for rules to branch
on is a small, deliberate code change. What stays hard, on purpose: getting AOS
to decide whether a customer qualifies. That remains ADR-016's territory, and
nothing here moves the line.

---

## ADR-036 — A submission is addressed to people, and remembers where it went

Date: 2026-08-06
Status: Accepted

**Schema.** `Database/migrations/0024`, `0025`.
**Code.** `src/domain/submissions/recipients.ts`.

**The problem.** "Send to Bank" was one dropdown listing every branch in the
system, and it recorded a branch id. Three things were wrong with that, and
only the first is cosmetic.

A flat branch list stops working the moment the catalogue has real depth.
After Milestone 8 there were twenty-eight lenders with one placeholder branch
each, called "HDFC Bank — Coimbatore" — which is not an address anybody can
lodge a file at, on the screen whose entire purpose is choosing one.

A submission had nowhere to record **who** it went to. A file goes to bankers,
plural: the relationship manager, the credit manager who will actually raise
the query, and the branch's shared mailbox so it does not die when one person
is on leave. `submission.bank_contact_id` (0006) held exactly one, so in
practice the other two were typed into a note, outside search and reporting.

And a submission's counterparty was **read live from master data**. A branch
renamed next year would silently rewrite what a file lodged today says it did.

**Decision, in three parts.**

**1. Bank → Branch → Contacts, and a contact is not always a person.**
`bank_contact` gains `contact_name` and `is_primary_contact`, and `person_id`
becomes nullable.

The nullable `person_id` is the non-obvious part. ADR-034 established that a
work mobile and a bank email belong to the *posting*, not the human — which is
why they sit on `bank_contact` and not on `person_identifier`. This carries
that one step further to a conclusion ADR-034 did not need: for many of the
addresses a file is actually sent to, **there is no human being to model**.
`homeloans.cbe@bank.com` is a desk. Under the old shape, recording one meant
inventing a `person` row with a fabricated name — precisely the "fictional
people in an operational contact list" Milestone 8 refused to seed.

The link to `person` is kept, not replaced. A named manager who moves to
another bank next year is one new `bank_contact` against the same person, and
that is the whole point of ADR-006 and ADR-014.

**2. A submission snapshots its counterparty.** `submission` gains
`institution_organisation_id`, four `*_at_submission` text columns and
`snapshot_taken_at`; `submission_recipient` snapshots name, designation and
email per recipient.

The live foreign keys stay — they are how you reach the branch as it is *now* —
and beside them sit plain text columns recording what it was called **when the
file went**. Both are true and neither is derivable from the other.

This is deliberate denormalisation, and the justification is not convenience.
A rejection recorded against a branch is evidence (ADR-028), and evidence that
changes underneath you is not evidence. It is also not a breach of ADR-018's
ban on duplicated personal data: an institution is not a person and a branch
name is not personal data, so there is nothing here to redact.

`snapshot_taken_at` exists because the backfill for pre-0024 rows is a
*reconstruction* from master data as it stands today, not a record of what was
true then. Nothing recorded what those branches were called last year. A
reconstruction that cannot be told apart from a record is worse than an empty
column, so the timestamp is left NULL for exactly those rows.

**3. Recipients are a list, and typed-in addresses are first class.**
`submission_recipient` is a new table rather than more columns, because the
count is genuinely open — "multiple recipients" is the normal case, not the
exception. `bank_contact_id` is nullable so an address that is not in the
catalogue can still be used: a workflow that only accepts catalogued addresses
is one people work around by keeping their own list, which is the failure that
made this milestone necessary in the first place.

**What the catalogue now claims, and what it still refuses.** 0025 adds the
institutions the Coimbatore market has and Milestone 8 lacked — small finance
banks and co-operative banks, both named in the brief and both genuinely
absent, plus the Tamil Nadu housing financiers and gold-loan NBFCs whose
absence was conspicuous for *this* city. Every lender's single placeholder
branch is replaced by the localities it operates in: RS Puram, Gandhipuram,
Race Course, Peelamedu, Saibaba Colony, Singanallur, Saravanampatti, Town
Hall, Ukkadam, Kuniyamuthur, Thudiyalur.

Milestone 8's line is kept exactly where it was. **No street addresses, no
IFSC codes, no phone numbers, no branch emails, and not one named human
being.** That refusal matters more here than it did in Milestone 8: the Add
Bank workflow offers catalogued contacts as recipients at the exact moment
somebody is about to send a real customer's file, so a seeded banker email
would not merely look plausible — it would be sent to.
`Frontend/src/fake/lenders.test.ts` asserts each of those absences, so a
later plausible-looking address fails the build rather than becoming fact by
repetition.

**What was refused, and where it attaches later.** No `submission_package`
table, no `submission_email` table, no draft state, no attachment manifest.
Each was considered and declined on ADR-028's grounds: building the mapping
table before there is anything to map produces an empty table plus a screen
nobody fills. The seams already exist and each is one migration away —
Gmail/Outlook drafts read `submission_recipient` and
`submission.submission_mode_id`; a package is a junction between `document`
and `submission`, both of which exist; submission history is already the
event log (ADR-005); per-bank status tracking is already independent
(ADR-004). Email size splitting and OCR are not modelled at all, and should
not be until the milestone that needs them states what it needs.

`recipient_kind` (to/cc) is the one exception, and it earns its place on a
narrow argument: it is the only thing about a recipient that a future email
integration **cannot infer** and the office genuinely knows — the manager is
addressed, the branch mailbox is copied. Recording it now costs a text column;
not recording it means asking the question again about files that have already
gone.

**Consequences.** Adding a bank, a branch or a contact is data entry on the
Lender Catalogue screen, and adding a *kind* of lender, role or submission
mode is a row in Master Data — neither needs a developer. Editing any of it is
now safe in a way it was not: nothing an administrator does to the catalogue
can change what a historical file says it did.

What stays hard, on purpose: getting AOS to choose the bank. Routing and
eligibility remain ADR-016's territory, and this milestone gives them a
catalogue to read without moving that line an inch.

---

## ADR-037 — A document type has two names; the checklist is grouped; one case may add its own row

**Status.** Accepted, Telecaller Workflow Refinement.
**Schema.** `Database/migrations/0026`.
**Code.** `src/domain/requirements/document-catalogue.ts`, `default-rules.ts`,
`Frontend/src/screens/CaseDetail.tsx`.
**Guide.** `Docs/Document Requirement Engine.md`.

**The problem.** ADR-035 made the checklist correct and ADR-035's audit made
it complete. Neither made it *sayable*. The person who reads it out is a
telecaller on a call to a customer in Coimbatore, and the list they were
reading said "Credit Bureau Consent", "Parent Document (Title Chain)" and
"Stock and Book Debts Statement" — forty rows of it, in rule order, with a
PAN card three lines above a stock statement. So every call involved a live
translation into ordinary language, done differently by each caller and
differently again on each call, and the customer heard a different list
depending on who rang them.

Three further things showed up in the same watching. A business loan created
during the first call generated almost no business documents, because every
business rule waited on a fact — a borrowing firm, an employment type — that
nobody had recorded yet: the newest case had the emptiest list, at the one
moment the list was needed. The Overview showed facts (GST registered,
construction stage, occupation, property) that a user could read and not
change. And there was nowhere to put the one extra letter that one bank asks
for on one file, so it went into WhatsApp.

**The decision.**

*A document type carries what we call it and what they call it.* `name` is the
customer-facing name; `local_name` is what Tamil Nadu calls it where that
differs — *EC / Villangam*, *Udyog Aadhaar*, *CIBIL Consent*. Both are shown,
because the customer says one and the bank wants the other, and the person on
the phone needs both. Where a form number is what makes a document
unambiguous it goes in the name itself (*GST Registration Certificate (GST
REG-06)*) and the local name is dropped rather than repeated — a local name
that is only the official name reworded is noise on the row. A `description`
is one sentence a first-week joiner can read out, and where a document has
common substitutes the substitutes *are* the description: address proof reads
"EB bill, gas bill, ration card, passport, driving licence", because that is
the question every collection call gets.

*A `category` groups the checklist into six blocks* — KYC, Income, Business,
Financial, Property, Additional — in the order a call runs. A telecaller works
one topic at a time; the grouping is what lets them say "now the business
papers" instead of reading a list back item by item.

All four fields stay master data. The right wording for a Coimbatore branch is
something the branch knows and a developer does not.

*Six rules key on the customer product rather than on a recorded fact.* If
someone opened a business loan, there is a business, and that is knowable
before anything else has been asked. They attach to the applicant and stand
down the moment a real firm is added, because the firm's own rules then ask
for the same papers in the firm's name. This is the same species of fix as
ADR-035's audit finding 1, applied to the rest of the business set rather than
to GST alone.

*A requirement may be added by hand to one case.* Category, name, mandatory or
optional, description — then uploaded, verified and versioned exactly like a
generated one. Two constraints make it safe: no master rule is touched, and
regeneration passes it through untouched, because no rule produced it and so
no rule's absence may withdraw it. Withdrawing one marks it `not_applicable`
rather than deleting it (BR-034) — somebody asked the customer for it.

**What was rejected.**

*A per-case `document_type` row.* It would have made a custom document
indistinguishable from a real one, at the cost of master data that nobody owns
and that grows by one row every time a bank has a whim. The requirement
carries its own name instead and points at a single `other_document` type, so
storage, versioning and verification need no special case.

*Letting a Login Executive add a rule instead.* A rule added for one file
changes every other open case. That is how a rules engine becomes something
users are afraid of, and the whole value of ADR-035 is that they are not.

*Translating names in the interface.* Keeping the technical name in the
database and a friendly label in the UI puts the wording where a business user
cannot edit it and where a report will not see it. The name IS the data.

**Consequences.** Ownership of a document now follows the requirement's
subject rather than the document type's declared `owner_kind` — a proprietor
is asked for a balance sheet, a type declared `organisation`, attached to a
person, and resolving from the type looked for an organisation that did not
exist and refused the upload under BR-030. The type's declaration is now the
fallback for a case-level row with no subject at all.

Every fact the Overview displays has an input behind it, including the two
that live on a party rather than the case (occupation, business type) and the
property, which can now be corrected and removed rather than only added.

What stays hard, on purpose: nothing here decides anything. A friendlier name
does not make the checklist more or less right, and ADR-016's line on
eligibility is untouched.

---

## ADR-038 — The period belongs to the row's name; sections follow the collection call, not the filing cabinet

**Status.** Accepted, Document Requirement Engine audit.
**Schema.** `Database/migrations/0027`.
**Code.** `src/domain/requirements/document-catalogue.ts`, `default-rules.ts`.
**Guide.** `Docs/Document Requirement Engine.md`.

**The problem.** The engine was reported as having grown duplicate document
definitions. It had not — there is exactly one definition per code and the
tests now hold that shut permanently. What the report was actually seeing was
worse, because it was invisible to every test that checked document *codes*: a
business loan asks for two years of GST returns, two of the ITR, two of the
balance sheet and two of the P&L, and all eight rows rendered under four
names. Each row is a genuinely distinct year with its own upload, its own
verification and its own storage path. On screen it read as four documents
asked for twice.

That is not a cosmetic problem. A checklist that looks buggy is one people stop
trusting *including the parts of it that are right*, and the first thing a
telecaller does with a list they distrust is stop reading it out.

Two smaller findings came out of the same audit. One document genuinely *was*
asked for twice: a proprietor on a business loan was asked for the personal ITR
and the business ITR, which on a proprietorship are the same filing. And the
six sections introduced by ADR-037 were a filing taxonomy rather than a
collection order — "Business" against "Financial" put a GST certificate beside
a stock statement and separated the GST certificate from the GST returns.

**The decision.**

*The period goes in the row's name, not beside it.* `GST 3B – FY 2025-26` and
`GST 3B – FY 2024-25` are visibly two different asks; `GST 3B` twice is not.
A `period_kind` on the document type says which name to use — **financial year**
for returns, banking and accounts, **assessment year** for the ITRs, Form 16 and
Form 26AS. The underlying window is the same April-to-March year in both cases
and nothing in the engine, the storage path or the period columns branches on
it. It is presentation, and it is presentation that decides whether the
customer hands over the right year's document on the first call: a return is
known by its assessment year, and "the FY 2024-25 ITR" invites them to fetch
the one they filed *in* 2024-25, which is the year before.

*The business ITR is the business's return.* `business_itr_by_product` names
`org_itr`; `income_itr` stands down on business loans; and a separate rule asks
the promoter for their personal return only where a firm is actually borrowing,
which is the only situation in which the two are different documents.

*Sections follow the call.* **KYC**, **Business Registration**, **Business
Financials**, **Income**, **Property**, **Additional**. A telecaller collects a
business's papers in one pass and its numbers in another, because those are two
different calls and often two different people at the customer's end.

*`examples` is a first-class field.* Where the honest answer to "what counts?"
is a list rather than a sentence, it is stored as a list and rendered as
bullets. Address proof is the case that justifies it on its own.

**What was rejected.**

*Splitting Patta and Chitta into two rows.* Asked for twice across two
milestones, and declined both times with the same reason: Tamil Nadu merged the
two records in 2015 and the e-Services portal issues them as a single extract.
Two rows would have the telecaller ask for two documents the VAO hands over as
one, and would leave a permanently unsatisfiable second row on every property
file. Both words are in the name, which is what the request was actually for.

*Making Udyam registration mandatory on the general business loan.* Amaze asks
for it every time, so it is on the list from the moment the case opens — but a
genuine small proprietor often has not registered, and a mandatory row would
hold a file that no lender is holding. It stays mandatory on the scheme
products, where the scheme itself requires it.

*Renaming the underlying document codes to match the new display names.* The
codes are what documents, requirements and storage paths point at. A prettier
`gst_returns` is worth nothing and costs a data migration.

**Consequences.** `app.document_category` was rewritten rather than extended,
because a value added with `alter type ... add value` cannot be used in the
same transaction and this migration inserts rows using the new values. Both
columns that reference it are parked as text across the swap.

`Frontend/src/fake/checklists.test.ts` now opens one case of each product
family Amaze sells and asserts no two rows say the same thing for the same
subject. That is the assertion that would have caught this, and every
code-level test in the repo missed it.

---

## ADR-039 — Documents go to the banker as email, composed deterministically, split at 10 MB, behind a provider seam

**Status.** Accepted, Email & WhatsApp Integration milestone.
**Schema.** `Database/migrations/0030`.
**Code.** `src/domain/submissions/{attachments,batching,compose,package}.ts`,
`src/domain/communications/`, `Backend/mail-server.mjs`,
`Frontend/src/fake/mail.ts`.
**Guide.** `Docs/Email and WhatsApp Integration.md`.

**The problem.** ADR-036 built the address book — bank, branch, bankers — and
said outright that nothing in AOS sends anything. So what actually happens is
that somebody opens the Windows folder, attaches scans to a Gmail message until
Gmail complains, starts a second message, and sends. Nothing records which
documents went, in which email, to whom, or whether the third one bounced. "Did
you get the FY 2023-24 return?" is a weekly phone call, and the only evidence
anything was sent lives in one person's Sent items.

**The decision.**

*Only a verified document is sendable.* Not a pending row, not one sitting
unread, not a rejected upload, not a waiver. A file going to a bank is Amaze
asserting that somebody looked at these papers, and BR-032 says that somebody is
always a named human. A blocked row is shown DISABLED with its reason rather
than hidden — "why is the ITR not in this?" is the question the user has, and a
hidden row leaves them to discover the omission at the bank.

*Ten megabytes of attachments per email, and that is proved rather than
assumed.* Gmail caps a message at 25 MB and base64 inflates attachments by four
thirds plus line wrapping. `base64EncodedSize` computes it and a test asserts a
full 10 MB email clears Gmail's ceiling with better than 10 MB to spare. The
constraint is also a check constraint on `submission_package_email`: a rule the
business calls hard should not depend on the application remembering it.

*Grouping, then packing — in that order, and size wins where they conflict.* A
bin-packer would produce fuller emails and put the GST certificate in email 3
with the GST returns in email 1, so a credit manager queries a certificate that
was already sent. Documents are grouped as a banker reads them, whole groups are
kept together where they fit, and only a group too large for one email is split.
The algorithm is written out in `batching.ts` because "deterministic and
explainable" is a requirement and an algorithm nobody can restate is neither.

*The email is written by code, not by a model.* Every word comes from facts AOS
holds. It is auditable (the subject can be re-derived, not merely quoted),
private (no customer name leaves for a third party to write "please find
attached"), consistent (a banker receiving forty files a month can recognise
one), free, and incapable of an outage. It still has to sound like an employee
wrote it, because an obviously automated note gets skimmed and the query comes
back anyway.

*A package is the decision, an email is what carried it.* `submission_package`
records that a person chose documents and pressed Send once;
`submission_package_email` is one message with its own status. That split is
what makes partial failure representable and a retry able to resend only what
failed. `submission_package_document` records which document at which VERSION
went in which email, and a unique index makes "exactly once" checkable rather
than asserted.

*No new permission.* Sending a file to a bank is what `submission.create`
already means (Workflow.md). Login Executive, Manager and Managing Partner hold
it; a Telecaller holds it at no scope, so collecting a document never becomes
authority to submit one. `document.read` is required alongside it, because this
action puts document bytes into an outgoing email and a role that may see a
submission exists without opening its documents must not be able to mail them.

*Nothing above the seam knows what Gmail is.* `EmailProvider` takes a recipient,
a subject, a body, attachments and an id, and returns a typed result per
message. Gmail lives in `Backend/mail-server.mjs` — the browser cannot hold a
refresh token, and shipping one in a bundle is not a configuration mistake to be
careful about, it is not a thing that can be done safely.

*The default provider refuses.* An unconfigured install reports
`not_configured` on every send. It does not queue and never reports success: a
timeline recording a submission that never happened would stop somebody chasing
a bank.

**What was rejected.**

*Compressing an oversized attachment.* A compressed bank statement is not the
document the customer signed. AOS names the file, states the limit, and says
what to do instead.

*Dropping an ineligible document from the plan and sending the rest.* The file
would reach the bank one document short and nobody would know. The plan is
refused whole.

*Storing the message body.* It is regenerated deterministically from the case,
so a copy would duplicate customer data into a second place for no information
gained — and give ADR-018's redaction a second place to reach. The subject IS
stored, because it depends on how the documents happened to split and is not
derivable afterwards.

*Trusting the review screen.* `prepareDocumentPackage` returns a fingerprint of
the document ids and versions it planned from, and the send refuses if it no
longer matches. The window between reviewing and confirming is small and exactly
long enough for a colleague to replace a document.

*Sending the banker submission over WhatsApp.* A document message carries one
file, has no subject, no cc and no thread a colleague can be added to, and lives
on one handset. WhatsApp is for the CUSTOMER side — document requests,
reminders, status updates — and the seam
(`src/domain/communications/whatsapp-provider.ts`) is shaped for pre-approved
templates because a business-initiated message cannot be free text. Nothing
implements it, and `WHATSAPP_REQUIRED_CONFIGURATION` records exactly what an
administrator would have to obtain first.

**Consequences.** The prototype now has a third local process
(`Backend/mail-server.mjs`), and `npm run dev` starts it. Real Gmail delivery is
NOT exercised by any automated test — it needs a live credential and is not
deterministic — so the Playwright suite runs the backend in an explicitly named
`capture` mode that builds each message the same way and writes it to disk. The
manual check that covers real delivery is written down in the guide.

`document` rows still carry no content type, so one is derived from the file
extension when attaching. That is the right place for the fallback, but a
content type recorded at upload would be better and is a small future change.
