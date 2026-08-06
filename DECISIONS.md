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
