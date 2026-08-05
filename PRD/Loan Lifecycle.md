# Loan Lifecycle

**Status:** Draft for review.

Every stage a case can occupy, what each one means, and what it takes to leave.

---

## Two axes, not one

Restating ADR-004 because everything here depends on it:

- **Case stage** — where the *customer's journey* stands. One value, always.
- **Submission status** — where *one file at one bank* stands. Many at once.

A case is `Submitted` while its five submissions are variously sanctioned,
rejected and pending. Neither axis can express the other.

---

## The stages

| # | Stage | Means | Leaves when |
|---|---|---|---|
| 1 | **New** | Lead captured. Nobody has spoken to them yet. | First contact is logged |
| 2 | **Contacted** | Spoken to. Interest and rough requirement established. | Appointment set, or requirement firm enough to proceed |
| 3 | **Appointment Fixed** | Meeting scheduled. | Meeting happens, or is abandoned |
| 4 | **Documents Pending** | Loan product known, requirements generated, collection under way. | Every applicable requirement is `verified` |
| 5 | **Ready for Submission** | File complete and verified. Awaiting bank selection. | First submission is **dispatched** — not merely created |
| 6 | **Submitted** | At least one live submission at a bank. | A submission reaches Sanctioned |
| 7 | **Sanctioned** | At least one bank has sanctioned, with an offer on file. | A submission reaches Disbursed |
| 8 | **Disbursed** | Money has moved. | Commercial close-out done |
| 9 | **Closed** | Complete. Invoice raised, commission settled. | Terminal |
| — | **Lost** | Will not proceed. Always carries a reason. | Terminal, but reopenable |

Ten stages. Two of them — `Closed` and `Lost` — are terminal.

**Created is not dispatched.** A submission row is created in status
`not_submitted`, which is a real and useful state: a bank, a product and a
contact have been chosen, but the file has not physically gone out. The case
leaves *Ready for Submission* when a submission moves **beyond** `not_submitted`,
not when the row appears. Advancing the case on row creation would report a file
as at the bank while it sits on the desk.

**Stage ordinality.** The eight non-terminal stages are ordered, and that order is
what "a requirement becomes applicable from stage X" compares against. The two
terminal stages have **no position in that order** — asking whether a requirement
is due on a lost case is meaningless. Enforced in `src/domain/case/stages.ts`.

---

## Three stages I removed, and why (ADR-020)

**"Documents Requested" and "Documents Received" as separate stages.** Partial
receipt is the normal state — four of nine documents in, two verified, one
rejected by the checker. "Received" cannot be answered yes or no, so as a stage
it would be perpetually ambiguous and set by whoever last touched the case.

The requirement engine already expresses this precisely, with a number. One stage
(`Documents Pending`) plus `progress = verified / applicable` says strictly more
than two stages ever could.

> **Rule: do not encode as a stage what a metric expresses better.** Stages are
> for changes of *kind*. Progress within a kind is a measurement.

**"Verification Pending" as a separate stage.** Same argument — verification is a
per-document status (BR-032), and rolling it up into a case stage loses which
document is actually waiting.

**"Eligibility Received".** This is a submission status, and a per-bank one. As a
case stage it would be false the moment two banks disagree.

---

## On Hold is not a stage (ADR-021)

Cases stall for reasons that have nothing to do with progress: the customer is
travelling, the property fell through, a co-applicant's documents are stuck in
another state.

Making this a stage would destroy information — when the hold lifts, you need to
know *where the case was*. So hold is **orthogonal**: a flag on the case carrying
a reason and a follow-up date, and it can coexist with any non-terminal stage.

A held case is excluded from "needs attention" views until its follow-up date,
which is the entire operational point — holds exist so that a stalled case stops
generating noise without being forgotten.

*This is a design addition, not in the original stage list. Rationale: without
it, users will express holds by parking cases in a wrong stage, and the stage
data becomes unreliable.*

---

## Stage is stored, and auto-advanced

Stage is a **stored column**, not a derived value. Transitions are explicit and
every one writes an event (BR-050).

But stages 6–8 have a definitional relationship to submissions: a case *is*
`Sanctioned` precisely when some submission is sanctioned. Requiring a human to
also click "advance stage" guarantees drift between the two axes.

Resolution: the system advances these stages automatically when a submission
status changes, and the resulting event names **the system** as actor with the
triggering submission as cause. Stored, so there is one source of truth;
automatic, so it cannot drift; evented, so it is auditable.

Auto-advance is one-directional. A rejection at one bank never moves a case
backwards, because another bank may still be live.

See ADR-019. *(This also corrects a wrong citation in `Data Model.md`, which
attributed the stored-stage decision to ADR-005.)*

---

## Lost

Reachable from **any** non-terminal stage, including `Sanctioned` — customers walk
away after sanction, usually over rate or a competing offer, and that is among the
most commercially important things the company can learn.

Reason is mandatory and comes from a controlled list (BR-024's sibling rule):

Rate too high · Sanctioned elsewhere · Customer not eligible · Documents
unavailable · Property issue · Customer postponed · Unreachable · Not
interested · Duplicate case

Free text may accompany the reason, never replace it.

**Reopening** is allowed — a postponed customer returning in six months is common.
It restores the case to the stage it was lost from, records an event, and keeps
the loss in history. A new case is *not* created, because that would sever the
earlier conversation from the new one.

---

## Closed vs Disbursed

Deliberately separate. Disbursement is the customer's endpoint; the company's
work continues — invoice, commission from the bank, referrer payout. A case
sitting in `Disbursed` for two months is a real operational signal that money is
owed to Amaze, and collapsing the two stages would hide it.

---

## Open questions

1. **Does `Appointment Fixed` earn its place?** It is arguably a task
   (`task` with a due date), not a stage. It survives here because "how many
   appointments this week" is a question management will ask. If that turns out
   not to be asked, it should be removed and expressed as a task.
2. **Partial disbursement** is normal in construction-linked home loans — money
   arrives in tranches. Does `Disbursed` mean *first* tranche or *final*? This
   affects when commission is due, and needs a business answer.
3. **Who may mark a case Lost?** Owner alone, or does management confirm above a
   ticket size?
