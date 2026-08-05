# Consistency Audit — 2026-08-05

Full cross-check of PRD, ADRs and code before implementation continues.
Scope: 10 PRD documents, 23 ADRs, 5 source files (~3,300 lines).

**26 findings. All fixed.** One was a live bug in shipped code.

---

## A. Contradictions (8)

**A1 — `user.role` was singular.** `Data Model.md` gave `user` a `role` column
while `Permissions.md` and BR-061 require many roles per user with union
semantics. The schema as written could not express the permission model.
→ Removed. Added `user_role` and `role_permission`. ADR-022.

**A2 — "A person is unique by primary phone."** Constraint 1 survived from before
ADR-013 and directly contradicted it: phones are shared and recycled, which is
why identity moved to a surrogate ID.
→ Rewritten: PAN unique when verified, phone collisions prompt rather than block.

**A3 — Aadhaar listed as an identifier type** in `person_identifier`, contradicting
ADR-017 (V1 stores no Aadhaar number).
→ Removed from the type list, with the reason stated inline so it does not creep
back.

**A4 — Constraint 5 was backwards.** It read "a case cannot *leave* Ready for
Submission while any requirement is pending". `Workflow.md` and
`transitions.ts` both require exactly that move — it is how a case returns to
Documents Pending when a co-applicant is added. The constraint prohibited
required behaviour.
→ Corrected to "cannot *enter*", with the backwards transition named as intended.

**A5 — Document ownership: three types or four?** `Data Model.md` said person /
property / case; BR-030 said person / property / organisation / case; the
relationship diagram showed organisation → document.
→ Four. Organisation-owned documents are a borrowing firm's GST, ITR and
financials — the reason Organisation exists at all (ADR-009).

**A6 — Submission statuses shown as a linear chain**, implying
`Rejected → Withdrawn → Disbursed`. `Workflow.md` correctly shows branches and
the `query_raised → under_process` loop.
→ `Data Model.md` now lists vocabulary only and points at `Workflow.md` as
authoritative.

**A7 — "Nine stages"** in `Loan Lifecycle.md`, listing ten.
→ Corrected, plus an explicit note on terminal stages having no ordinal position.

**A8 — `case.status` duplicated `case.stage`.** Fields `status (active / lost /
closed)` and `stage` could disagree, and nothing said which won.
→ `status` removed. Stage already carries `lost` and `closed`.

---

## B. Duplicate concepts (3)

**B1 — `case.referrer` column vs the `referrer` role in `case_party`.** Two
representations of one fact, guaranteed to diverge.
→ Column removed; `case_party` is the single representation.

**B2 — `bank contact` as a `case_party` role vs the `bank_contact` entity.**
→ Removed from `case_party`. A bank contact belongs to a branch and is referenced
by the submission.

**B3 — `task.*` wildcard notation** in `Permissions.md` alongside explicitly
enumerated permissions elsewhere.
→ Wildcards abolished. A shorthand makes "who can assign tasks?" unanswerable by
reading the document.

---

## C. Undefined entities and missing fields (7)

**C1 — `employment`** was referenced twice ("linked to people via an employment
link") but never defined. Employment type drives requirement generation, so this
was a hole under the requirement engine.
→ Defined, with employment type, income and history.

**C2 — `case_property`** referenced in prose and the diagram, never given an
entity block. → Defined.

**C3 — `case.stage_before_lost` missing.** `transitions.ts` reads it to restore a
reopened case. **Code depended on a field the schema did not have.**
→ Added.

**C4 — Hold fields missing.** ADR-021 made hold a first-class concept; `case` had
no `is_on_hold`, `hold_reason` or `hold_until`. → Added.

**C5 — `offer.read` used by the Finance role, absent from the catalog.** → Added.

**C6 — `user_role` / `role_permission` missing** — see A1.

**C7 — `task.update` missing** from the catalog while roles implied it. → Added.

---

## D. Outdated references (5)

**D1 — ADR-017, 018, 020, 021 were orphans** — cited nowhere outside
`DECISIONS.md`. Four accepted decisions had never propagated into the PRD, which
is how architecture and documentation drift apart.
→ All four now cited where they apply.

**D2 — `Data Model.md` open question 1 (Aadhaar)** — resolved by ADR-017, still
listed as blocking. → Marked resolved.

**D3 — `Business Rules.md` "the one rule I cannot yet state" (erasure)** —
resolved by ADR-018. → Rewritten as resolved, with retention flagged as the part
that genuinely remains open.

**D4 — `Business Rules.md` second open question (role partitioning)** — answered.
→ Replaced with the resolution; BR-063 and BR-064 added.

**D5 — `Product Principles.md` #8 marked "pending confirmation"** — confirmed, and
reframed as permissions-versus-workspaces. Also `README.md` still listed three
written documents as unwritten. → Both corrected.

---

## E. Leaky abstractions (2)

**E1 — `summariseProgress` took a raw `currentStageIndex: number`.** Every caller
would have had to do ordinal arithmetic the domain layer should own.
→ Now takes a `CaseStage`. See F1 for why this mattered.

**E2 — `Data Model.md` Part 1 headed "Six challenges", containing seven.** → Fixed.

---

## F. Live bug (1)

**F1 — Terminal stages had the highest ordinal.**

`CASE_STAGES` is ordered `… disbursed, closed, lost`, so the natural index for
`lost` was 9 — higher than every real stage. Combined with E1,
`summariseProgress(requirements, 9)` marked **every requirement as due on a lost
case**, including ones that only become applicable at disbursement.

Nothing threw. The progress figure was simply wrong, on exactly the cases nobody
looks at closely — the failure mode that survives longest in production.

→ `CASE_STAGE_PROGRESSION` now contains only the eight non-terminal stages.
`stageOrdinal()` returns `null` for terminal stages, and callers must handle it
rather than receive a plausible-looking number. Three regression tests added.
Recorded as ADR-023.

This is the finding that justifies the audit. It came from implementation
exposing an ambiguity the documents never had to resolve: the PRD said stages
were ordered without saying whether outcomes were part of that order.

---

## Verification

```
npm run typecheck   clean
npm test            47 passed
```

## Not fixed — deliberately

These are open *questions*, not inconsistencies, and each is recorded where it
belongs:

- Retention periods versus erasure (legal).
- Whether Manager holds `commercial.view` (business).
- Login fees, referrer commissions, case numbering, per-bank checklists.
- Partial disbursement semantics for construction-linked loans.
- `team` scope is defined but unused until a reporting hierarchy exists.

## Recommended cadence

Re-run this audit at each layer boundary — after the schema, after RLS, after the
service layer. Drift is cheap to fix at the boundary and expensive afterwards.
The four orphaned ADRs (D1) had been orphaned for a single work session, which is
how quickly it happens.
