# Data Model

**Status:** Draft for review. No UI, no technology. This document defines the
business language every future feature depends on.

---

## Part 1 — Seven challenges to the proposed model

The proposed model was a good starting point. Seven things in it will cause pain,
and all seven are cheap to fix now.

### 1. Employee, Customer, Referrer and Bank Manager are not types of Person

They are *roles a person plays*, and one person plays several of them, sometimes
at once, sometimes over time.

- A satisfied customer refers his brother. He is now customer *and* referrer.
- A referrer takes his own top-up loan. Now he is a customer too.
- An employee's father applies through the company.
- A bank manager changes banks. The relationship moved; the person did not.

If Customer and Referrer are separate tables, that one human becomes three rows
with three phone numbers that drift apart, and "have we dealt with this person
before?" becomes unanswerable — which is exactly the question AOS exists to
answer.

**Fix:** one `person` table. Roles are *relationships*, held in separate tables,
each with its own lifecycle. A person accumulates roles; they are never a
subtype.

### 2. A Case does not have "a Customer"

It has an applicant, usually a co-applicant, sometimes a guarantor, often a
referrer, and later a bank contact. Home loans in particular are almost always
joint. `case.customer_id` is wrong on day one.

**Fix:** `case_party` — the people attached to a case, each with a role.

### 3. Documents do not belong to Cases

An Aadhaar card belongs to a *person*. A sale deed belongs to a *property*. A
bank statement belongs to a person, for a period. If documents hang off the case,
then a repeat customer re-uploads his Aadhaar for every loan, and the same
document exists three times with three expiry dates. That directly violates
"information is entered once" and "zero duplicate data".

**Fix:** a document is owned by the person or property it describes. Cases
*reference* documents. A second case for the same customer starts with his KYC
already satisfied — which is a visible, valuable moment in the product.

### 4. Events should be a log, not the source of truth

"Almost everything is an event" is the right instinct and the wrong architecture
if taken literally. Rebuilding current state by replaying events (event sourcing)
is a serious commitment: every query becomes a fold, every bug becomes an
archaeology exercise, and a five-person team will not maintain it.

**Fix:** state tables hold the truth. `event` is an append-only log written in
the *same transaction* as the state change that caused it. You still get
timelines, audit, MIS, performance metrics and AI summaries "for free" — the
stated goal — without betting the system on replay. The log is never edited and
never deleted.

### 5. A Lead is not a different thing from a Case

The proposed lifecycle starts at "New Lead" and ends at "Closed", which is
correct — so do not build a separate Lead object that gets "converted". Every
conversion seam creates duplicate records, lost history, and the question "was
this a lead or a case in March?"

**Fix:** one `case` table. A lead is a case in an early stage. Cases that die
early are `Lost` with a reason, not deleted, and they remain searchable.

### 6. "Every case is in exactly one stage" is false once you submit to two banks

Covered previously, now settled: the case carries the customer-journey stage; each
submission carries its own status. See ADR-004.

### 7. Optional participants are optional, structurally

Co-applicant, guarantor, referrer, employer and property are *optional
relationships*, not required entities. The default case is one applicant and
nothing else, and that case must be fully workable and able to reach 100%
complete. No screen may present an empty section for a participant who does not
exist, and no requirement may be generated for one. See
`Requirements and Progress.md` and ADR-010.

### Reversed: Organisation is now an entity

The first draft of this document kept employer as a text field with autocomplete.
That was wrong, for a reason the reporting arguments alone did not settle: **for
business loans and LAP the borrower may itself be a firm**, holding its own GST
certificate, ITR and financial statements. Organisation must exist as a party
regardless of the employer question, so declining to use it for employers is
arbitrary — and free-text employer names accumulate variants that are expensive
to clean up later. Modelled thin, and resolved invisibly behind a plain typing
experience. See ADR-009 and `Identity Resolution.md` Part 4.

---

## Part 2 — The entities

Each one must justify itself against the four-question test: what operational
problem does it solve today, what future migration does it prevent, what
complexity does it add, and is that complexity justified now.

### Identity

**person** — every human AOS knows, exactly once.
Fields: person_id (permanent, system-generated, meaningless), full name, date of
birth, address, created_at, created_by.
Identity rule: **the Person ID is the identity.** It never changes and is never
derived from a real-world attribute. Identifiers live in their own table below.
Duplicate people is the single most likely way this system rots.
**`full_name` is nullable, deliberately.** Redaction under ADR-018 nulls personal
columns in place, leaving a tombstone that the surviving cases and events still
point at. A `NOT NULL` here would make erasure impossible without deleting the
row, which BR-003 forbids. Stated because the first person to read the migration
will otherwise "fix" it.

**person_identifier** — the evidence by which a person is recognised.
Fields: person_id, type (phone / PAN / email / bank account), raw value,
normalised value, is_primary, valid_from, valid_to, verification source
(self-declared / seen on document / verified against issuer), added_by.
**Aadhaar is deliberately absent from the type list.** V1 stores no Aadhaar
number and does not use it as a match key (ADR-017). The Aadhaar document image
may be held with the number masked, as a `document`, not as an identifier.
Identifier types differ in exclusivity and strength, and matching logic depends
on knowing the difference: PAN is exclusive and near-definitive; phone is shared,
recycled and therefore never definitive alone. Validity dates are what make
recycled numbers safe — a 2024 call is attributed to whoever held the number in
2024. Full model in `Identity Resolution.md` Part 3 and ADR-013.

**user** — a person who can log into AOS. One-to-one with person, optional.
Fields: person_id, **auth_identity_id**, active, last_login.
`auth_identity_id` is the link to the authentication provider's session identity.
It is the field **every RLS policy depends on** — a policy asks "which user is
this?" and the answer starts here — so it is `NOT NULL` and unique, and a user
row without one cannot log in and should not exist.
The table is called `app_user` in the schema; `user` is reserved in Postgres.
Note there is **no `role` column.** A user holds many roles at once and receives
the union of their permissions (BR-061, ADR-022), so roles live in `user_role`.
An employee who leaves is deactivated, never deleted — their name must survive on
every case they touched.

**user_role** — role assignments. Fields: user_id, role, granted_by, granted_at,
revoked_at.
Assignment is runtime data, not schema: adding a role to someone is a
configuration change, never a migration.

**role_permission** — which permissions a role carries. Fields: role, permission,
scope (own / team / all).
Seeded from the catalog in `src/domain/permissions/`, which is the single
definition. Never hand-written in SQL — one rule, one implementation. RLS
policies read this table. See `Permissions.md`.

**referrer_profile** — a person who sends business.
Fields: person_id, referrer type (customer / bank manager / agent / builder /
staff), commission terms, active.

**bank_contact** — a person's working relationship with a bank branch.
Fields: person_id, branch_organisation_id, designation, active_from, active_to.
Modelled as a relationship precisely so that a manager moving banks — or moving
branches within a bank, which is more common — is one new row, not a lost
contact.

### The core object

**case** — one loan application journey. The centre of the system.
Fields: case_number, loan_product_id (Amaze's
taxonomy — set at creation, drives requirements), requested amount, **stage**,
owner (user), lost_reason, stage_before_lost, source, is_on_hold, hold_reason,
hold_until, created_at, closed_at.
Rules:
- **`case_number` is `AL-YYYY-NNNNN`** — sequential within the calendar year,
  allocated at creation including for leads, immutable thereafter, and unique.
  **The UUID is the identity; nothing joins on the number** (ADR-024). Nothing is
  encoded in it: a case whose loan product changes mid-case is a supported
  operation, and an encoded number would either be wrong forever or force a
  renumbering that breaks immutability. Allocated from `case_number_sequence`,
  not a Postgres sequence, because sequences gap on rollback.
- Exactly one accountable **owner** at any time. Ownership changes are events.
- Stage is stored, auto-advanced by submission changes, always evented (ADR-019).
- **There is no separate `status` column.** `stage` already carries `lost` and
  `closed`; a second status field would be a duplicate state that can disagree
  with the first. Terminal-ness is derived from stage.
- `stage_before_lost` exists so a reopened case returns to where it was lost from
  (`Loan Lifecycle.md` — Lost). Null unless the case is or has been lost.
- Hold is orthogonal to stage and coexists with any non-terminal stage
  (ADR-021). A held case is excluded from attention views until `hold_until`.
- **There is no `referrer` column.** The referrer is a `case_party` with the
  referrer role — one representation, not two.
- A case is never hard-deleted.

**case_party** — the parties on a case: people, or an organisation as borrower.
Fields: case_id, person_id **or** organisation_id (exactly one), role (applicant /
co-applicant / guarantor / referrer / borrower_firm), is_primary.
Rules: exactly one primary applicant — the **only** mandatory party. Every other
role is optional and absent by default; a role that does not exist has no row, no
placeholder and no empty UI section. A party appears at most once per role per
case.
**Role determines which reference is set.** `borrower_firm` is an organisation
and carries `organisation_id`; `applicant`, `co-applicant`, `guarantor` and
`referrer` are people and carry `person_id`. Exactly one of the two is set on
every row, and which one is not free — a guarantor that is an organisation, or a
borrowing firm that is a person, is not a thing. Enforced as a check constraint
rather than left to the application, because it is exactly the kind of rule that
holds until the one code path nobody remembered.
Removing a party sets `removed_at` and turns that party's requirements
`not_applicable`. It is never a delete: the fact that the case once had a
co-applicant is what the timeline is for.
**`bank contact` is deliberately not a case_party role.** A bank contact is a
relationship between a person and a branch (`bank_contact`), referenced by the
submission that person is working. Putting them on the case as well would be two
representations of one fact.

**case_property** — links a case to the properties involved.
Fields: case_id, property_id, role (collateral / purchase / both).
A property changed mid-case stays linked to the case's history rather than being
unlinked (`Workflow.md` — edge cases).

**employment** — a person's employer.
Fields: person_id, organisation_id, designation, income, employment type
(salaried / self-employed / business owner), start_date, end_date, is_current.
Employment type drives requirement generation, which is why it is a modelled
relationship rather than a field on `person` — it changes, and the history
matters when a bank asks about job stability.

### Banking

**Banks and branches are organisations.** There is no separate `bank` table — a
lender is an `organisation` carrying the lender role plus a `lender_profile`
extension, and a branch is an organisation whose `parent_organisation_id` points
at its bank. This is the same pattern people use (`person` + `referrer_profile`),
and it means alias handling, fuzzy matching and merge work on "IIFL" / "IIFL Home
Finance Ltd" / "India Infoline" for free. See ADR-014 and ADR-015.

**lender_profile** — organisation_id, lender type (bank / NBFC / HFC), panel
status, standard turnaround, notes.

**loan_product** — **Amaze's own taxonomy, independent of any bank.**
Fields: category (Home Loan / Business Loan / Personal / LAP), variant (Purchase /
Self Construction / Plot Purchase / Balance Transfer / Top-up / Working Capital /
Term Loan / Overdraft), active.
Drives document requirements, workflow shape, and reporting by business line.
Critically, it is known **at case creation**, before any bank is chosen — which is
what makes the requirement engine possible.

**bank_product** — a specific lender's offering.
Fields: organisation_id (the bank), loan_product_id, name, min/max amount,
indicative rate, active.
Drives submission rules and eligibility. Kept declarative — see ADR-016 on why
this is deliberately not a rules engine.

**rejection_reason** — Amaze's standardised rejection categories.
Fields: code, name, description, active, display_order.
Master data, not an enum (ADR-028). New lenders arrive with new vocabulary on a
timescale of weeks; if adding a category needs a migration, people will pick the
nearest wrong value instead, which silently corrupts the one dataset the table
exists to protect. Retired categories are deactivated, never deleted, so historic
submissions keep pointing at the category they were classified under.

This is the **internal** category. The bank's own wording lives on the
submission, verbatim, and never substitutes for it — that is what makes
rejections comparable across banks that describe the same refusal differently.

*Note the deliberate asymmetry with `lost_reason`, which stays a code-defined
list in `src/domain/case/stages.ts`.* The dividing line is whose vocabulary it
is: lost reasons are Amaze's own view and change on a timescale worth a code
review; rejection reasons must absorb other organisations' vocabulary, which
nobody at Amaze controls. Our vocabulary lives in code; the world's lives in
data.

**submission** — a case sent to one bank branch. **This is where the real work
lives.**
Fields: case_id, branch_organisation_id, bank_product_id, bank_contact_id,
submitted_by, submitted_at, **status**, status_reason,
**rejection_reason_id**, **bank_reason_text**, login_fee_amount,
login_fee_paid_at, bank reference number.
The branch, not the bank, is the counterparty: a file goes to a specific place
and a specific relationship manager works it.
Statuses: `not_submitted`, `submitted`, `under_process`, `query_raised`,
`eligibility_received`, `sanctioned`, `rejected`, `withdrawn`, `disbursed`.
These are **not a linear chain** — `query_raised` loops back to `under_process`,
and `rejected` / `withdrawn` are exits reachable from several points. The
authoritative transition diagram is in `Workflow.md`; this list is vocabulary
only.
`not_submitted` is a real state, not a placeholder: a bank, product and contact
have been chosen but the file has not gone out. The case stage advances on
**dispatch**, not on row creation (`Workflow.md`).

Rules: a case may have many submissions; a case may have at most one *disbursed*
submission.

**Rejection carries two things** (BR-024, BR-026, ADR-028):
`rejection_reason_id` is Amaze's standardised category, mandatory when the status
is `rejected`, drawn from the `rejection_reason` master-data table.
`bank_reason_text` is what the bank actually said, verbatim, and is optional. The
category is what reports group by; the verbatim text is what proves the category
was chosen honestly. That reason set becomes the most valuable dataset the
company owns, and it is only analysable because the category is structured.

`login_fee_amount` is masked behind `commercial.view` (ADR-026): that a fee was
paid is visible to everyone working the file; the figure is not.

**submission_query** — one query a bank raised on one submission.
Fields: submission_id, raised_at, question, answered_at, answer, answered_by.
`Workflow.md` requires that each query be recorded separately with what was
asked and what was sent, because *"how many queries did this branch raise?"* is a
real question about that branch. A status that merely oscillates between
`query_raised` and `under_process` answers it with "one" — the loop is the single
most common real-world transition, and without a row per pass it is lossy.

*Added while writing the schema. The requirement was already in `Workflow.md`;
the entity block was missing.*

**offer** — what a bank came back with. Fields: submission_id, sanctioned amount,
rate, tenure, processing fee, conditions, valid_until, accepted.
Separate from submission because a bank can revise an offer, and comparing the
original against the revision is the conversation you have with the customer.

### Assets and paperwork

**property** — collateral or the property being purchased.
Fields: address, type, area, estimated value, ownership status, survey/document
numbers.
Owned independently of any case: the same property appears in a purchase, a
later top-up, and a balance transfer. Linked to cases via **case_property**
(role: collateral / purchase / both).

**document** — one uploaded file.
Fields: owner (person_id **or** property_id **or** organisation_id **or**
case_id — exactly one), document type, file reference, period covered (for
statements/ITR), issue and expiry dates, verification status, verified_by,
verified_at, uploaded_by, uploaded_at, version.
Organisation-owned documents are a borrowing firm's GST certificate, ITR and
financial statements — the reason Organisation became an entity at all (ADR-009).
Matches BR-030's four owner types.
Rules: documents are versioned, never overwritten. Verification is an explicit
human act with a name attached to it. Case-owned documents are only those that
genuinely belong to the application itself — the sanction letter, the login form.

**document_requirement** — what a given case still needs.
Fields: case_id, document_type_id, **required_of_case_party_id** /
**required_of_case_property_id**, status (pending / received / verified / waived /
not_applicable), applicable_from_stage, **satisfied_by_document_id**, waived_by,
**waived_at**, reason.

Four things about those fields:

- **`required_of` is a typed reference, not a description.** Exactly one of
  `required_of_case_party_id` and `required_of_case_property_id` is set, or
  neither — a case-level requirement such as the login form belongs to no party.
  A free-text "which party" would make "what is this co-applicant still missing?"
  a string comparison.
- **`satisfied_by_document_id`** names the document that satisfied the
  requirement. Without it, a verified requirement cannot be traced to the file
  that verified it, and re-verifying after a new version becomes guesswork.
- **`waived_at` accompanies `waived_by`.** A waiver records who, when and why
  (BR-035); `waived_by` alone answers two of the three.
- **`applicable_from_stage` is drawn from the eight progression stages, not the
  ten case stages** (ADR-023, and `CASE_STAGE_PROGRESSION` in
  `src/domain/case/stages.ts`). `closed` and `lost` have no position in that
  order, so a requirement "applicable from lost" is not a statement with a
  meaning.

Rows are **generated** from the case's actual composition, never from a universal
checklist — a case with no guarantor generates no guarantor rows at all. Waived
and not_applicable rows are excluded from progress arithmetic entirely. Full
rules in `Requirements and Progress.md`.
This table powers the login executive's one question: *what is missing before this
file can go to the bank?*

### Reference data

Three tables that exist because ADR-025 refused a settings module. There is no
key-value configuration table; configurable-without-a-code-change is achieved per
kind of thing, and each kind gets the shape that suits it.

**document_type** — the kinds of document AOS recognises.
Fields: code, name, description, owner_kind (person / property / organisation /
case), requires_period, requires_expiry, active, display_order.
Referenced by `document` and `document_requirement`. A table rather than an enum
because requirement templates key off it and adding a document type must not be a
migration (ADR-025). `owner_kind` is what stops a payslip being attached to a
property.

**operational_threshold** — tunable day-counts.
Fields: key, value_days, description, updated_by, updated_at.
Idle threshold per stage (`Workflow.md` open question 1), offer-expiry warning
lead time, unverified-document age, default hold follow-up.
**The keys are a closed enum defined in `src/domain/settings/` and seeded by
migration.** The value is editable at runtime; the key set is not. That asymmetry
is the entire design: it is the same pattern as the permission catalog (ADR-022),
and it is the difference between a lookup table and a configuration system. You
cannot add a key without a code change, which is the friction that stops this
becoming the place things go when nobody wants to model them properly.

**case_number_sequence** — one row per calendar year.
Fields: year, last_value.
Locked and incremented by `app.allocate_case_number()`. A counter rather than a
Postgres sequence because sequences gap on every rolled-back transaction, and a
customer quoting `AL-2026-00087` when the company has opened 71 cases invites a
question with no good answer (ADR-024). At ~10 cases a month the serialisation
cost is nil and contiguity is worth more than the concurrency. Not readable by
any client: the counter is not information anyone needs, and exposing it would
invite reports that treat case numbers as a count of business done, which they
are not.

### Organisations

**organisation** — every non-human party: employers, borrowing firms, builders,
developers, vendors, banks and branches.
Fields: canonical name, roles (employer / borrower / builder / developer /
vendor / lender / branch — multiple allowed), industry, city,
parent_organisation_id, active.
Roles overlap constantly — a construction firm is a builder on one case, a vendor
on another, and someone's employer on a third — so roles are flags, not tables.
`parent_organisation_id` exists for one purpose only: branch → bank. General
hierarchies, parent companies and contact directories are out of scope for V1.

**organisation_alias** — organisation_id, alias text, source.
Legal suffixes are stripped before matching, so "ABC Textiles" and "ABC Textiles
Pvt Ltd" collide as intended.

Linked to cases via **case_party** where the organisation is the borrower, and to
people via an employment link where it is an employer. Users never create an
organisation explicitly — they type a name and the system resolves it.

**person_alias** — person_id, alias text, source. Every wrong-but-used spelling is
kept, because that spelling is what someone will search next time.

### Work and communication

**task** — something a human must do, in the future.
Fields: case_id (optional), assigned_to, title, due_at, priority, completed_at,
completed_by.
Tasks are *intent*. Events are *fact*. They are never merged.

**communication** — a real exchange with a person: call, WhatsApp, email, SMS,
meeting.
Fields: case_id, person_id, channel, direction, occurred_at, subject, body or
summary, recorded_by, external message id.
Rules: WhatsApp and email are logged against both the person and the case. A
person's full history is visible from their profile, across every case.

**note** — internal commentary. Fields: case_id, author, body, created_at.
Immutable after a short edit window. Notes are not a place to store structured
facts — if something is being written in notes repeatedly, it wants a field.

**event** — the append-only spine.
Fields: occurred_at, actor (user or system), entity type, entity id, case_id,
event type, payload (before/after), source (ui / automation / import).
Rules: **append-only. No updates. No deletes.** Written in the same transaction
as the state change. Every timeline, audit trail, MIS report, productivity metric
and AI summary reads from here.
**Payloads reference people and organisations by ID only.** No embedded names,
phone numbers or identifier values, ever. The event log is never redacted
(BR-051), so any personal data copied into a payload would be unerasable and
would defeat ADR-018. Denormalising personal data into an event is prohibited,
not discouraged.

---

## Part 3 — Relationships

```
person ──1:0..1── user ──1:N── user_role
person ──1:0..1── referrer_profile
person ──1:N──── person_alias
person ──1:N──── person_identifier
person ──1:N──── document
person ──1:N──── case_party ──N:1── case
person ──1:N──── communication ──N:1── case
person ──1:N──── bank_contact ──N:1── organisation (branch)
person ──1:N──── employment ──N:1── organisation (employer)

role ──1:N── role_permission           (seeded from the domain catalog)

organisation ──1:N── organisation_alias
organisation ──1:N── document
organisation ──1:N── case_party        (as borrower firm)
organisation ──1:0..1── lender_profile (banks only)
organisation ──1:N── organisation      (bank → its branches, one level only)

case ──1:N── document_requirement
case ──1:N── task
case ──1:N── note
case ──1:N── event
case ──N:1── loan_product              (known at creation; drives requirements)
case ──1:N── case_property ──N:1── property ──1:N── document
case ──1:N── submission ──N:1── organisation (branch)
                  ├──N:1── bank_product ──N:1── loan_product
                  ├──N:1── rejection_reason   (when rejected; BR-024)
                  └──1:N── offer

document_requirement ──N:1── document_type
document_requirement ──N:0..1── case_party      (whose requirement it is)
document_requirement ──N:0..1── case_property   (or which property's)
document_requirement ──N:0..1── document        (satisfied_by)
document             ──N:1── document_type
case                 ──N:1── case_number_sequence  (by year, at allocation only)
```

Read as sentences:

- One person can be on many cases, in different roles on each.
- One case has exactly one primary applicant, and any number of optional others —
  frequently none.
- One case can be submitted to many bank branches; each submission moves
  independently.
- One submission can produce several offers over time; at most one is accepted.
- One property can be attached to many cases across years.
- A document belongs to a person, a property, or a case — never to two.
- Everything that happens produces an event.

---

## Part 4 — Constraints the system must enforce

1. A person is identified by their Person ID, never by an identifier value. A
   verified PAN is unique across people. Phone numbers are **not** unique — they
   are shared and recycled — so a phone collision prompts rather than blocks, and
   any override is an event (ADR-013).
2. Every case has exactly one primary applicant and exactly one owner.
3. A case can have at most one disbursed submission.
4. A submission cannot reach Sanctioned without an offer attached.
5. A case cannot **enter** *Ready for Submission* while any applicable
   requirement is unverified. It is returned to *Documents Pending* automatically
   if one appears later — that backwards move is required behaviour, not a
   violation (`Workflow.md`). Waiving is allowed, named, and reasoned.
6. Nothing is hard-deleted. Cases are Lost or Closed; people and employees are
   deactivated.
7. Every state change writes an event, in the same transaction, or the state
   change does not happen.
8. Verification is always attributed to a named human, never to the system.
9. A `case_party` row references a person **or** an organisation, never both and
   never neither, and which one is determined by the role: `borrower_firm` is an
   organisation, the other four roles are people.
10. A submission in `rejected` has a `rejection_reason_id`. The bank's verbatim
    wording is optional and never substitutes for it (BR-024, BR-026).
11. A `document_requirement` references at most one of `case_party` and
    `case_property` — a case-level requirement references neither.
12. `case_number` is unique, immutable after insert, and matches
    `AL-YYYY-NNNNN`.

---

## Part 5 — Open questions

1. ~~**Aadhaar storage.**~~ **Resolved by ADR-017:** V1 stores no Aadhaar number.
   Image only, masked, never an identifier type. To be revisited only with legal
   advice.
2. **Login fees.** Are they tracked per submission as money owed and collected?
   If yes, it may pull a small payments concept into scope.
3. **Referrer commissions.** Calculated and tracked in AOS, or handled outside?
   Tracking them means payouts, which is real scope.
4. ~~**Case numbering.**~~ **Resolved by ADR-024:** `AL-YYYY-NNNNN`, sequential
   within the calendar year, allocated at creation, immutable, nothing encoded.
   The UUID remains the identity.
5. **Bank checklists.** Do document requirements differ enough per bank to need
   per-bank templates in v1, or is one master checklist plus manual additions
   enough to start?
6. ~~**Bank rejection reasons.**~~ **Resolved by ADR-028:** master data, not an
   enum, with the bank's verbatim wording recorded alongside the standardised
   category. The seeded list is a starting point and is expected to be revised
   once real rejections accumulate — revising it is a data change, which is the
   point.
