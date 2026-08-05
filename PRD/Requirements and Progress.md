# Requirements and Progress

**Status:** Draft for review.

How AOS decides what a case still needs, and how "done" it is — without ever
penalising a case for information that does not apply to it.

This document exists because two requirements in the brief are actually the same
requirement: *optional participants must never be forced*, and *progress must
never depend on optional information*. Both reduce to one rule.

---

## The rule

> **A case is measured only against what that specific case genuinely requires.**

Not against a universal checklist. Not against the most complex case the system
can represent. Against its own contextual requirement set.

The corollary, and the reason most systems get this wrong:

> **"Not applicable" and "required but missing" are different states, and the
> system must know the difference.**

A salaried applicant with no co-applicant, no guarantor and no property
identified yet can be at **100% complete** and correctly ready for submission.
Nothing about that case is missing. A system that shows him at 40% because the
guarantor fields are empty is lying, and users will learn to ignore the number —
which destroys it as a signal permanently.

---

## Part 1 — The simplest case must be genuinely simple

The default shape of a case is:

```
Case
└── Applicant          (exactly one, always)
```

That is a complete, valid, workable case. Everything else is optional:

| Participant | When it exists |
|---|---|
| Co-applicant | Joint applications only |
| Guarantor | When a bank asks for one |
| Referrer | When the case came through someone |
| Organisation (employer) | Salaried applicants |
| Organisation (borrower firm) | Business loans, LAP |
| Property | Secured loans, and often only from a later stage |

Design consequences, stated as hard rules:

1. **Nothing optional appears on a creation screen.** Creating a case asks for
   the applicant and the loan type. Nothing else.
2. **Optional participants are added by an explicit user action** — "Add
   co-applicant" — never by a form field sitting empty waiting to be filled.
3. **Empty optional sections are hidden, not shown greyed out.** An empty
   Guarantor panel on 90% of cases is visual noise that teaches users to skim
   past the screen.
4. **Adding a participant later is normal, not an edit-correction.** It generates
   that participant's requirements at the moment they are added, and it is an
   event.

---

## Part 2 — Requirements are generated, not listed

A case's requirement set is derived from its actual composition:

```
Loan type          →  Home loan / LAP / Personal / Business / Balance transfer
Applicant profile  →  Salaried / Self-employed / Business owner
Party set          →  Which optional participants actually exist
Property           →  Whether the loan is secured, and whether a property is identified
Target bank        →  Bank-specific additions, once a submission exists
Stage              →  Some requirements only become applicable later
```

Each of those inputs contributes requirement rows. Two consequences worth being
explicit about:

- **A requirement for a party that does not exist is never generated.** No
  co-applicant means no co-applicant KYC rows. Not rows marked N/A — no rows at
  all. Absence is silence.
- **Adding a co-applicant in week three adds new requirements and moves progress
  backwards.** This is correct and must not be hidden. The timeline shows why:
  *"Progress 100% → 72%: co-applicant added, 4 new documents required."* An
  honest number that moves is more useful than a flattering one that doesn't.

### Requirement status values

| Status | Meaning | Counts toward progress? |
|---|---|---|
| `pending` | Required, not received | Yes — denominator |
| `received` | Uploaded, not yet verified | Yes — partial credit |
| `verified` | Checked by a named human | Yes — numerator |
| `waived` | Required, deliberately skipped, with reason and name | Excluded, and visible |
| `not_applicable` | Does not apply to this case | **Excluded entirely** |

`not_applicable` exists for requirements that were generated and then turned out
not to apply — a bank dropping a demand, an ITR year that predates the business.
It is *not* how absent participants are handled; those simply never generate
rows.

### Progress

```
progress = verified / (total requirements − waived − not_applicable)
```

Optional information that does not apply is never in the denominator. It is
arithmetically impossible for an unused optional field to reduce a case's score.

---

## Part 3 — Applicability by stage

Some requirements are real but not yet due. A property valuation is required for
a home loan, but demanding it on day two — before a property is even chosen —
makes the checklist wrong and the progress bar useless.

Each requirement therefore carries an **applicable-from stage**. Before that
stage it is not counted and not shown as missing; it appears in an "upcoming"
grouping instead.

This is what lets the login executive's screen answer exactly one question —
*what is missing before this file can go to the bank* — without listing things
that nobody could possibly have yet.

---

## Part 4 — Case health

Progress measures completeness. Health measures whether the case is *in trouble*,
which is a different question and must not be collapsed into the same number.

Health is contextual, and every input is relative to what the case actually is:

- Days since the last customer contact
- Days stalled in the current stage, compared to the norm for that stage
- Overdue tasks
- Documents received but unverified for too long
- Submissions with no bank response beyond expected turnaround
- Sanction offers approaching expiry

Health is never reduced by an absent optional participant. A simple case is not
an unhealthy case.

Deliberately excluded from V1: any predictive or scored "likelihood to convert."
That needs historical data the company does not have yet, and a wrong prediction
early would discredit the whole idea. Revisit when there is a year of outcomes in
the event log.

---

## Part 5 — What this forbids

Stated as prohibitions, because these are the failure modes:

- No "complete your profile" nagging for fields that do not apply.
- No required fields that exist because some other loan type needs them.
- No progress bar that can never reach 100% on a simple case.
- No screen that shows an empty section for an absent participant.
- No blocking a stage transition on a requirement that is `not_applicable` or
  waived.
- No universal document checklist applied to every case regardless of type.

---

## Part 6 — Open questions

1. **Who can waive a requirement?** Waiving lets a file move to a bank without a
   document. Login executive, or management approval?
2. **Bank-specific checklists in V1** — real per-bank templates, or one master
   list per loan type plus manual additions? Templates are more correct and more
   setup work before anyone can use the system.
3. **Self-employed profiles** vary a lot (ITR years, GST, business vintage). Is
   one self-employed profile enough for V1, or do we need to split it?
4. **Does progress belong in the UI at all for telecallers?** It answers the
   login executive's question. It may be noise on a calling screen.
