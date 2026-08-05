# Workflow

**Status:** Draft for review.

How a case moves. `Loan Lifecycle.md` defines the stages; this defines the
transitions, their guards, and the edge cases that break naive designs.

---

## Case stage transitions

| From | To | Trigger | Guard | Actor |
|---|---|---|---|---|
| New | Contacted | First communication logged | — | User |
| New | Lost | Marked lost | Reason required | User |
| Contacted | Appointment Fixed | Appointment created | Date in future | User |
| Contacted | Documents Pending | Loan product confirmed | Product set; requirements generated | User |
| Appointment Fixed | Documents Pending | Meeting completed | Product set | User |
| Appointment Fixed | Contacted | Appointment cancelled | — | User |
| Documents Pending | Ready for Submission | Last applicable requirement verified | **No applicable requirement outstanding** | System |
| Ready for Submission | Documents Pending | New requirement appears | Any applicable requirement unmet | System |
| Ready for Submission | Submitted | First submission **dispatched** | ≥1 submission not in Not Submitted | System |
| Submitted | Sanctioned | Any submission → Sanctioned | Offer attached (BR-023) | System |
| Sanctioned | Disbursed | Any submission → Disbursed | At most one disbursed (BR-022) | System |
| Disbursed | Closed | Close-out completed | Invoice raised | User |
| *any non-terminal* | Lost | Marked lost | Reason from controlled list | User |
| Lost | *stage it was lost from* | Reopened | — | User |

Every transition writes an event naming its actor (BR-050, BR-052). System
transitions name the system and cite the change that caused them.

---

## The backwards transition that matters

`Ready for Submission → Documents Pending` is the one people forget, and it is
not an error case. It fires when a co-applicant is added in week three, or a bank
asks for a document nobody anticipated.

It must be **automatic and visible**: the case moves back, progress drops, and
the timeline says why — *"Ready for Submission → Documents Pending: co-applicant
added, 4 new requirements."* Silently leaving the case in `Ready for Submission`
while it is no longer ready is the failure this prevents. See ADR-010.

---

## Submission status transitions

Independent per submission. A case may hold many of these simultaneously.

```
Not Submitted → Submitted → Under Process → Eligibility Received → Sanctioned → Disbursed
                     ↓            ↓                  ↓                  ↓
                  Rejected    Query Raised       Rejected           Withdrawn
                                   ↓
                            Under Process
```

### `Not Submitted` is a real state, not a placeholder

It is load-bearing now that the case stage advances on **dispatch** rather than
on row creation. A submission in `Not Submitted` means a real decision has been
made and recorded — *this file is going to this branch, on this product, through
this relationship manager* — before the file physically goes out.

That gap is where the work happens: assembling the set, getting the RM's
agreement to receive it, deciding the order in which banks are approached. It is
also how a file gets prepared for three banks and sent to one. Collapsing it
would either lose that decision or report a file as at the bank while it sits on
a desk.

A submission sitting in `Not Submitted` for too long is a health signal, not an
error.

Rules:

- `Query Raised → Under Process` is a loop, and it is the single most common
  real-world transition. Each query is recorded separately with what was asked
  and what was sent, because "how many queries did this bank raise" is a real
  question about that branch.
- `Rejected` requires a reason from a controlled list (BR-024).
- `Sanctioned` requires an offer (BR-023).
- `Withdrawn` is *our* choice to stop; `Rejected` is theirs. Never conflate them
  — the distinction is the whole value of the rejection dataset.

---

## Edge cases

These are the situations that a naive state machine handles wrongly.

**Sanctioned at one bank, rejected at another.** Normal. Case stage is
`Sanctioned`; both submissions keep their own status. No conflict, because the
axes are separate.

**Rejected everywhere.** Every submission rejected. The case does **not**
auto-move to Lost — the next move is usually to submit to a sixth bank. It stays
`Submitted` and surfaces in "needs attention". Marking Lost is a human decision,
because only a human knows whether options remain.

**Sanction lapses.** Offers carry `valid_until`. An expired sanction does not
reverse the case stage; it raises a task and flags the case's health. The bank
sanctioned; that fact happened.

**Customer accepts a different bank after sanction.** The unaccepted submissions
go to `Withdrawn`, not `Rejected`.

**Re-submission after rejection.** A rejected file, corrected and sent back to the
same branch, is a **new submission** — never a status reset on the old one. The
rejection is history and must survive; a reset would erase the fact the bank ever
said no.

**Loan product changes mid-case.** The customer wanted a purchase loan; it becomes
a plot purchase. Requirements regenerate: already-satisfied ones keep their
status, newly applicable ones appear as pending, no-longer-relevant ones become
`not_applicable` rather than being deleted (BR-034). Documents already collected
are never discarded — they belong to the person, not the case (ADR-007).

**Property changes.** Same treatment. Property-linked requirements regenerate; the
old property stays linked to the case's history rather than being unlinked.

**Two cases for one customer at once.** A home loan and a business loan running in
parallel. Both are independent cases; the person is shared; their KYC satisfies
both without re-upload. This should be surfaced — each case shows the other.

**Duplicate case discovered.** Two telecallers logged the same enquiry. Resolved
by marking one Lost with reason `Duplicate case` and linking it to the survivor.
Cases are not merged — merging is for identities (people, organisations), not for
process records, because two cases genuinely happened and both timelines are
true.

---

## What triggers what

Stated so automation is not invented ad hoc later:

| Event | Consequence |
|---|---|
| Case created | Requirements generated from loan product + party set |
| Party added | Requirements for that party generated |
| Party removed | That party's requirements → `not_applicable` |
| Document verified | Requirement → verified; progress recomputed; stage re-evaluated |
| Requirement waived | Excluded from progress; event with actor and reason (BR-035) |
| Submission **dispatched** — leaves `Not Submitted` | Case stage → Submitted |
| Submission → Sanctioned | Case stage → Sanctioned; task to present the offer |
| Offer nearing expiry | Task raised to the case owner |
| Case idle beyond threshold | Health degrades; appears in "needs attention" |
| Hold expires | Case returns to active views |

**None of these are hardcoded in the interface.** They belong to a workflow layer
that the UI observes — required by the brief's rule that business logic never
lives in the UI.

---

## Open questions

1. **Idle thresholds** — how many days without contact before a case is stale?
   Probably differs per stage: three days in `New` is bad, three days in
   `Submitted` is normal bank turnaround. The values live in
   `operational_threshold`, keyed by stage (ADR-025); the numbers are the open
   part.

2. **Hold semantics — the transition table does not say what a hold blocks.**
   ADR-021 makes hold orthogonal to stage and says a held case is excluded from
   attention views. It does not say:

   - **May a held case transition at all?** A bank sanctions a file while the
     customer is travelling — the sanction happened, and refusing to record it
     would put the two axes out of step, which is the failure ADR-019 exists to
     prevent. The likely answer is that **system** transitions proceed and
     **user** transitions do not, but that is a business call, not an inference.
   - **Does marking a held case lost clear the hold?** A lost case is terminal
     and cannot be "on hold pending follow-up", so the hold is meaningless
     afterwards. Clearing it silently loses the reason the case stalled, which is
     often *why* it was lost.

   **This is the last gap in the workflow that a schema cannot decide for
   itself.** The columns exist either way; the guard does not. Until it is
   answered, `evaluateTransition` does not consider the hold flag at all, which
   is the conservative reading — holds affect what surfaces in attention views
   and nothing else.
3. **Can a case skip `Ready for Submission`?** In practice files are sometimes
   sent to a bank with a document still missing, on the RM's word. Currently the
   waiver mechanism (BR-035) covers this. Confirm that is enough and no skip is
   needed.

4. ~~**Who closes a case?**~~ **Resolved: Finance.** Closing asserts the invoice
   is raised, and Finance is the only role holding `case.close`
   (`Docs/Permission Matrix.md`).
