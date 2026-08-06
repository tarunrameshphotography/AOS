# Document Requirement Engine

Milestone 9. Source of truth for the design decision: **ADR-035**.
Schema: `Database/migrations/0021`, `0022`. Code: `src/domain/requirements/`.

---

## What it is

The engine decides **which documents a case needs**. Nothing else.

Before this milestone, that answer lived in `if` statements: a `KYC` array, a
`SECURED_PRODUCTS` set, a branch per product. Adding a product meant editing
code, and the office had no way to see — let alone change — what AOS would ask
a customer for.

Now every document AOS asks for is generated from a **rule row**. There is no
fixed checklist anywhere in the application. A loan manager can read all 86
rules on the Document Rules screen, change what is asked for, and take a rule
out of service, without a developer and without a deploy.

### What it deliberately is not

| Not | Why |
|---|---|
| **Eligibility** | A rule decides what to *ask for*, never whether a case will be approved. ADR-016's warning stands: an engine that confidently returns a wrong credit answer is worse than no engine. |
| **OCR** | Nothing here reads a document. It only decides that one is wanted. |
| **Bank submission** | These rules are Amaze's own file-completeness standard. A lender's own additional asks live on `lender_submission_rule` (Milestone 8) as reference material for a human. |

---

## The pieces

```
src/domain/requirements/
  rules.ts               the evaluator — facts in, requirements out. No database.
  default-rules.ts       the 86 researched default rules, seeded and then editable.
  document-catalogue.ts  the document types the rules name.
  financial-year.ts      India's April–March year; which types recur.
  progress.ts            what the generated set means for the case's score.

Frontend/src/fake/requirements.ts   the ADAPTER: database -> facts, and back.
Frontend/src/screens/DocumentRules.tsx   the screen a business user owns.
```

The split matters. `rules.ts` is pure: same facts plus same rules always give
the same list, so the whole engine is testable without a database and the
server and the prototype cannot diverge. Everything that needs a database —
resolving ids to codes, expanding financial years, preserving what has already
been collected — lives in the adapter.

---

## How a requirement gets generated

```
   loan_case + case_party + case_property + master data
                          |
                  buildCaseFacts()          ids resolved to codes, once
                          v
                     CaseFacts
                          |
      evaluateRules(rules, facts)           pure; one row per matching subject
                          v
              GeneratedRequirement[]
                          |
          expand()  financial years -> one row per year
          reconcile() keep what is satisfied; retire what is not
                          v
                document_requirement rows
```

### 1. Facts

A flat, code-based description of one case. The engine may ask about exactly
these (`FACT_PATHS` in `rules.ts`):

| Namespace | Facts |
|---|---|
| `case.` | `product_code`, `customer_product_code`, `security_type_code`, `property_requirement`, `gst_requirement`, `requested_amount`, `is_gst_registered`, `construction_stage`, `has_existing_obligations`, `has_collateral`, `has_co_applicant`, `has_guarantor`, `has_borrower_firm` |
| `party.` | `role`, `kind`, `employment_type`, `business_constitution`, `borrower_type`, `is_gst_registered`, `has_existing_obligations`, `is_primary` |
| `property.` | `role`, `type`, `ownership_type` |

The list is closed on purpose: a rule editor has to offer a dropdown of what
can be asked, and "any string" is not a dropdown.

**Three-valued facts.** `is_gst_registered`, `has_existing_obligations` and
`construction_stage` are nullable and stay nullable. `undefined` means *nobody
has asked yet*, which is not `false`. Rules use `is_true` / `is_false`
precisely so an unanswered question never silently generates — or silently
suppresses — a requirement.

### 2. Rules

```ts
{
  code: "gst_returns_firm",
  name: "GST returns",
  documentTypeCode: "gst_returns",
  scope: "party",                       // case | party | property
  partyRoles: ["borrower_firm"],
  partyKind: "organisation",
  applicability: "mandatory",           // mandatory | optional | not_applicable
  applicableFromStage: "documents_pending",
  financialYears: 1,
  conditions: [{ fact: "party.is_gst_registered", operator: "is_true" }],
  match: "all",                         // or "any"
  isActive: true,
  displayOrder: 530,
  notes: "GSTR-3B and GSTR-1 for the last financial year — the turnover the NBFC prices off.",
}
```

**Scope is what makes "absence is silence" (ADR-010, BR-033) automatic.** A
party-scoped rule is evaluated once per party who *actually exists*. A case
with no guarantor never enters the guarantor branch, so it generates no
guarantor rows — not rows marked N/A. The same is true of property rules: no
property on the file, no property documents.

**Operators:** `equals`, `not_equals`, `in`, `not_in`, `is_true`, `is_false`,
`exists`, `absent`, `gte`, `lte`.

An unknown fact satisfies `not_in`. That is deliberate: "ask for income proof
unless this is a gold loan" must still ask when the product has not been
recorded.

**Two rules landing on the same document for the same subject are merged, and
the merge always takes the stricter reading** — mandatory beats optional, the
earlier stage wins, the longer financial-year window wins. Anything else would
let adding a rule quietly weaken an existing one, which is the failure that
makes people stop trusting a rules engine.

### 3. Financial years

`financialYears: 2` produces **two independent rows**, one per year, each
carrying its own `period_start` / `period_end`. One year's ITR can never
satisfy another year's requirement (Milestone 3). Regeneration keeps any year
already on the file, so a verified three-year-old return does not become
`not_applicable` when the default window rolls forward, and a year a user
explicitly requested is never discarded.

### 4. Applicability and status

Two different axes, kept apart:

- **Applicability** (from the rule): `mandatory` or `optional`. Optional
  requirements are listed, collected and verified like any other, but are
  excluded from progress arithmetic — an optional document nobody chased must
  not hold a complete file at 94%.
- **Status** (on the row): `pending` → `received` → `verified`, plus
  `rejected`, `waived`, `not_applicable`. `rejected` is new in this milestone:
  a refused upload used to fall back to `pending`, which loses the fact that a
  human already spent time on it and told the customer why.

`waived` and `not_applicable` leave the arithmetic entirely (BR-034), which is
what lets a simple case reach 100%.

---

## Adding a business rule

### Through the screen (no deploy)

**Document Rules** in the top bar. Search, then Edit. Four fields are editable:
how strongly the document is wanted, when it becomes due, how many financial
years of it, and why the rule exists. Take a rule out of service with
**Take out of service** — rules are never deleted, because a requirement
generated two years ago names the rule that asked for it and "why was this
collected?" has to stay answerable.

Editing a rule does **not** rewrite every open case. A case picks the change up
the next time anything on it changes, or immediately from
**Re-evaluate against current rules** on its own Documents tab. Silently
rewriting hundreds of live checklists from an admin screen is how a system
loses the trust it needs to be useful.

### In the default pack (a new rule)

1. If the rule names a document type that does not exist yet, add it to
   `ENGINE_DOCUMENT_TYPES` in `src/domain/requirements/document-catalogue.ts`.
   A rule naming a type nobody created generates *nothing*, which looks exactly
   like a case that does not need the document — the test
   `never names a document type that does not exist` exists to catch it.
2. Add a `rule({ ... })` entry to `DEFAULT_REQUIREMENT_RULES` in
   `default-rules.ts`, in the block it belongs to.
3. Add a test to `default-rules.test.ts` phrased as a sentence an office user
   would recognise — "asks a salaried applicant for payslips, never for an
   ITR".
4. Regenerate `Database/migrations/0022` from the pack so the SQL seed and the
   TS pack cannot drift.

No other file changes. There is no switch statement to extend.

### A new fact

Adding a fact is a three-line change (`FACT_PATHS`, `resolveFact`, the fact's
column) — and it is the point at which a developer *should* be involved,
because a new fact means new data to capture somewhere.

---

## Research basis for the defaults

Sources: published documentation checklists from Indian banks, HFCs and NBFCs,
and Tamil Nadu registration- and revenue-department practice. The defaults are
market norms, not any single lender's policy, and every one of them is
editable.

**KYC** is universal and near-identical across lenders: PAN, Aadhaar, address
proof, photograph, signature. PAN is the one every lender treats as
non-negotiable above small-ticket gold.

**Income splits three ways, not two** — salaried (payslips + Form 16 +
salary-credit banking), self-employed professional (ITR + qualification and
practice proof), self-employed business (ITR + audited financials + GST). That
three-way split is why `employment_type` is master data rather than a boolean.

**Business documentation is driven far more by constitution than by product.**
A partnership is asked for its deed whatever it is borrowing; a private limited
for incorporation, MOA/AOA, a board resolution and a director list; a trust for
its deed. The pack models these as constitution-conditioned rules, which is how
lenders actually ask.

**Property documentation in Tamil Nadu has a state-specific core that generic
checklists miss.** Patta / Chitta (the revenue ownership record and land
classification), the parent document / title chain, and the Encumbrance
Certificate — "villangam" — from the Sub-Registrar. Every panel advocate's
legal opinion turns on those three. Layout approval is DTCP or the local body
(CMDA in Chennai's area), and an unapproved layout is the commonest reason a
Tamil Nadu plot file is declined. The one common exception the pack encodes:
an apartment held on undivided share has no patta of its own.

**Asset-backed products are documented by the security, not the borrower.** A
gold loan is KYC plus the appraisal note and nothing else; a loan against a
fixed deposit is KYC plus the receipt. Asking a gold-loan customer for two
years of ITR is the single most common way a generic checklist embarrasses a
branch, and the income rules carry an explicit exclusion for it.

**Recurring documents are asked for in financial years**, and the market norms
the pack seeds are: two years of ITR and financials, one year of GST returns,
and a rolling six to twelve months of banking.

**Scheme-linked products have hard prerequisites.** CGTMSE and PMMY are only
available to a registered MSME, so Udyam registration is mandatory there and
optional elsewhere.

### Corrections from the Milestone 9.1 audit

Live testing found the first pack asking for the wrong set on real files. All
five findings were the same shape: a rule waiting on a fact nobody had recorded
yet, or a rule scoped to a party that was not on the file. All five were fixed
as rule rows; no application code branches on any of it.

**GST is asked for on two independent grounds, not one.** The first pack keyed
every GST rule off "is this borrower GST-registered?" — a case fact that starts
unrecorded, so a business loan created this morning generated no GST rows at
all. But the product catalogue already declares `gst_requirement: mandatory` on
the eight business products and Commercial LAP (ADR-032). The pack now reads
both: the product's own declaration, *and* the borrower's registration. A
business loan asks for the GST certificate and returns out of the box; a home
loan asks only once someone records that the applicant is registered. Where
both grounds fire, the engine's merge produces one row, not two.

**A proprietor's business is underwritten like a firm's.** Balance sheet, P&L
and business banking were scoped to `borrower_firm`, so the ordinary MSME file
here — a proprietor borrowing in their own name, with no separate entity on the
file — was asked for a personal ITR and nothing else. Lenders ask a proprietor
for the same two years of CA-certified accounts they ask a company for; the
difference is whose name is on them, not whether they exist. Restricted to
business, LAP and home loan: an unsecured personal loan is assessed on ITR and
banking, and asking its customer for a balance sheet is over-asking of exactly
the kind the gold-loan exclusion exists to prevent.

**Form 26AS / AIS was missing entirely.** It is read against the ITR on every
self-employed file in this market, because it is the one income document the
borrower cannot author — a mismatch between the two is the commonest reason a
file stalls in credit. Mandatory for self-employed over the same two-year
window as the ITR; optional for salaried, where Form 16 already carries the
employer's TDS.

**Own contribution / margin money proof.** Margin runs 10–25% by ticket size
and no lender disburses without evidence the borrower has paid theirs — the
builder's receipt (OCR), or the transfer that funded it. Due from
`ready_for_submission`, because there is usually nothing to show until a
property and a price exist.

**Gold loans were being over-asked.** Credit bureau consent, guarantor
documents and existing-loan statements all fired on gold, which is sanctioned
at the counter on the ornaments and assesses no FOIR at all. The
asset-only exclusion now covers those three as well as income proof.

Also: practice proof is mandatory rather than optional on the professional
loan, where vintage is part of the pricing rather than a supporting document;
and an LLP is now asked for the resolution authorising it to borrow, having
previously been asked for its agreement but never for the authority to sign. A
partnership is deliberately still not asked — its deed names the authorised
partners itself.

---

## Worked examples

**Salaried home loan, one applicant, property on file.** KYC ×6, salary slips,
Form 16 ×2 years, bank statement, Form 26AS (optional), employment certificate
(optional), appointment letter (optional), then per property: sale deed, parent
document, patta/chitta, EC, property tax receipt, approved plan, sale
agreement; and from `ready_for_submission`: own contribution proof, legal
opinion, valuation, login form, NACH mandate.

**Self-employed home loan.** The same property set, but the income half
becomes ITR ×2, Form 26AS ×2, balance sheet ×2, P&L ×2 and twelve months'
banking — and no payslips or Form 16 anywhere.

**Business loan, proprietor, nothing yet recorded about them.** KYC, ITR ×2,
Form 26AS ×2, balance sheet ×2, P&L ×2, twelve months' banking, business proof,
GST certificate, GST returns — the GST rows because the *product* requires GST,
before anyone has been asked whether the borrower is registered. This is the
case the audit fixed.

**Working capital, GST-registered partnership.** The individual's KYC and ITR,
plus for the firm: business PAN, address proof, business registration, twelve
months' current account, two years' business ITR, balance sheet ×2, P&L ×2, GST
certificate, GST returns, partnership deed, director list, stock statement,
debtors/creditors statement. The firm's GST rows, not the individual's: once a
firm is on the file the proprietor rules stand down, so the checklist names one
subject for each document rather than two.

**Gold loan.** PAN, Aadhaar, address proof, photograph, signature proof
(optional), appraisal note, application form, and the lender's login form from
`ready_for_submission`. Eight rows. No income proof, no bureau consent, no
obligations, no NACH mandate — and if a guarantor is on the file, KYC for them
and nothing more.

---

## Where the ADR reasoning sits

| Decision | Reason |
|---|---|
| Rules are rows, not a `loan_product` → `document_type` junction | A rule is not "a document this product needs", it is "a document this *situation* needs", and a situation is a conjunction. A two-column junction table ends with a `notes` column full of conditions nobody can query. |
| The evaluator is pure | The server and the prototype run the same code. If the prototype asks for something, production will too, for the same reason. |
| Rules are deactivated, never deleted | A requirement generated two years ago names its rule. "Why was this collected?" has to stay answerable. |
| Case-party overrides rather than editing the person | A case screen that rewrites a shared person record corrupts every other case that person is on. "Salaried on this file, business owner on that one" is two facts, not one fact that keeps changing. |
| Editing a rule does not rewrite open cases | A rule change can touch hundreds of cases. Each picks it up when it next changes, or on an explicit re-evaluate. |
| Conditions are shown but not edited in the screen | Changing *when* a rule fires is a different decision from changing *what* it asks for. One form that did both would invite the accidental version of each. |
