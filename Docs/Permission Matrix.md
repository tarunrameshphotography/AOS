# Permission Matrix

**Derived from `src/domain/permissions/`, which is authoritative.** If this
document and the code disagree, the code is right and this document is stale.
The code's tests enforce that no table lacks a binding and no permission lacks a
target (ADR-027); nothing enforces that this file was updated, so treat it as a
reading aid rather than a source.

Produced by the ADR-027 sweep: the catalog is derived from the entity list, not
accumulated from the screens somebody happened to think about.

---

## How to read a cell

Every permission is an action **and** a scope (BR-064).

| Scope | Means |
|---|---|
| `own` | Rows reachable from a case the user owns or is a named participant on |
| `team` | Rows owned by anyone reporting to the user — **defined, unused in V1** |
| `all` | Every row |

`all` ⊇ `team` ⊇ `own`, so a check is one comparison. A blank cell means the role
does not hold the permission at any scope.

A user holds **many roles** and receives the **union** of their grants at the
widest scope any of them carries (BR-061).

---

## Roles × permissions

TC = Telecaller · LE = Login Executive · MG = Manager · FI = Finance · AD = Admin

### Cases

| Permission | TC | LE | MG | FI | AD |
|---|---|---|---|---|---|
| `case.read` | own | all | all | all | all |
| `case.create` | all | all | all | | |
| `case.update` | own | all | all | | |
| `case.assign` | | | all | | |
| `case.hold` | own | own | all | | |
| `case.mark_lost` | own | own | all | | |
| `case.reopen` | own | own | all | | |
| `case.close` | | | | all | |

### People, organisations, properties

| Permission | TC | LE | MG | FI | AD |
|---|---|---|---|---|---|
| `person.read` | all | all | all | all | all |
| `person.create` | all | all | all | | |
| `person.update` | all | all | all | | |
| `person.merge` | | | all | | |
| `person.override_duplicate` | | | all | | |
| `organisation.read` | all | all | all | all | all |
| `organisation.create` | all | all | all | | |
| `organisation.update` | all | all | all | | |
| `organisation.merge` | | | all | | |
| `property.read` | all | all | all | | all |
| `property.create` | | all | all | | |
| `property.update` | | all | all | | |
| `property.merge` | | | all | | |
| `employment.read` | all | all | all | | all |
| `employment.record` | all | all | all | | |

### Documents and requirements

| Permission | TC | LE | MG | FI | AD |
|---|---|---|---|---|---|
| `document.read` | own | all | all | | |
| `document.upload` | own | all | all | | |
| `document.verify` | | all | all | | |
| `document.delete_version` | | | | | |
| `requirement.waive` | | all | all | | |

### Banking

| Permission | TC | LE | MG | FI | AD |
|---|---|---|---|---|---|
| `submission.read` | own | all | all | all | all |
| `submission.create` | | all | all | | |
| `submission.update_status` | | all | all | | |
| `offer.read` | own | all | all | all | all |
| `offer.record` | | all | all | | |
| `offer.accept` | | all | all | | |

### Work and communication

| Permission | TC | LE | MG | FI | AD |
|---|---|---|---|---|---|
| `task.read` | own | own | all | | all |
| `task.create` | own | own | all | | |
| `task.update` | own | own | all | | |
| `task.assign` | | | all | | |
| `communication.read` | own | all | all | | |
| `communication.log` | own | all | all | | |
| `note.read` | own | all | all | | |
| `note.create` | own | all | all | | |

### Sensitive

| Permission | TC | LE | MG | FI | AD |
|---|---|---|---|---|---|
| `identifier.view_full` | | all | all | | |
| `commercial.view` | | | | all | |
| `event.view` | | | all | | all |

### Administration

| Permission | TC | LE | MG | FI | AD |
|---|---|---|---|---|---|
| `user.read` | all | all | all | all | all |
| `user.manage` | | | | | all |
| `role.assign` | | | | | all |
| `master_data.read` | all | all | all | all | all |
| `master_data.manage` | | | | | all |
| `report.view` | | | all | all | all |

---

## What the shape says

**Telecaller: cases are `own`, people are `all`.** Deliberate, and the single
most important asymmetry in the matrix. A telecaller must be able to discover
that the caller is an existing customer — that recognition is the product's
central promise (Principle #4). What they cannot do is browse a colleague's
cases.

**Login Executive holds nearly everything at `all`.** The login desk works
whatever file is in front of it, regardless of who sourced the lead. It stops at
ownership decisions: hold, mark lost and reopen stay `own`.

**Manager adds judgement, not reach.** Assignment, merges, task allocation,
reporting, the audit log. Not `case.close` — closing asserts an invoice is
raised.

**Finance is narrow by construction.** Read the case, close it, see the money.
No `case.update`, no `document.verify`, no documents at all.

**Admin runs the system, not the business.** See below — this is where the
derivation changed something.

---

## Four grants decided during derivation, not by the business

Flagged rather than buried. Each is a judgement made because the matrix could not
be completed without one, and each is cheap to reverse.

**1. Login Executive holds `case.update:all`** *(recorded in ADR-027)*. A desk
holding `document.verify` and `submission.create` at `all` but unable to correct
the requested amount on the file it is submitting is incoherent.

**2. `offer.accept` granted to Login Executive and Manager.** `Permissions.md`
assigned it to nobody, which looked like the same deliberate abstention as
`document.delete_version` — but it is not. `Workflow.md` requires that when a
customer accepts one bank, the other submissions go to `Withdrawn`. That
behaviour is unreachable if no role may accept an offer, so the omission was an
oversight rather than a decision.

**3. Finance gains `person.read:all` and `organisation.read:all`.**
`Permissions.md` gave Finance `case.read:all` and nothing else in this group,
which renders a case with no applicant name. Not a usable screen.

**4. Admin loses three reads that "all read permissions at `all`" implied.**
ADR-027 required the wildcard be enumerated and named two exclusions
(`identifier.view_full`, `commercial.view`). Enumerating forces a question the
wildcard hid: which reads are administering the system, and which are reading the
customers?

The line drawn is **structure, not content**. Admin sees that a case exists, who
owns it, what stage it is at and what happened to it — enough to answer "why can
this user not see that case?". Admin does not open the customer's documents,
calls or notes.

So `document.read`, `communication.read` and `note.read` are excluded, in
addition to ADR-027's two. The first of those is the load-bearing one: excluding
`identifier.view_full` while granting `document.read` would be theatre, because
the PAN card image is in the document store and a masked PAN column would protect
nothing.

**If any of these four is wrong, it is a one-line change in `roles.ts` plus a
re-seed.** None of them is structural.

---

## Two permissions the catalog gained

`master_data.read` — held by every role. It exists so that no table binds to a
null permission. "Everyone may read this" is a decision, and ADR-027 requires
decisions be written down rather than left as an absence.

`employment.record` — one permission rather than `employment.create` plus
`employment.update`. An employment row is corrected far more often than a genuinely
new one is added, and splitting them would mean every role holding one holds the
other.

---

## Permissions held by nobody

`document.delete_version`. Documents are versioned and never overwritten
(BR-031), and a replaced document may be the one a bank already saw. It stays in
the catalog so that the decision is explicit rather than accidental, and a test
asserts the reason is recorded. Recommendation stands: leave unassigned.

---

## Where each of these is enforced

**Row visibility — RLS on the base table.** Every table's `select` / `insert` /
`update` / `delete` binding is in `src/domain/permissions/tables.ts`, and a test
fails if any is missing.

**Column visibility — a masking expression in the view the client reads**
(ADR-026). Base tables are revoked from client roles. Exactly two permissions are
column-level:

| Table | Column | Revealed by | Otherwise |
|---|---|---|---|
| `person_identifier` | `value_raw`, `value_normalised` | `identifier.view_full` | Last four characters, rest masked |
| `referrer_profile` | `commission_terms` | `commercial.view` | Placeholder — presence visible, terms not |
| `submission` | `login_fee_amount` | `commercial.view` | Placeholder — that a fee was paid is visible, the figure is not |

Both consult one SECURITY DEFINER function, `app.has_permission(action, scope)`,
which is the only reader of `user_role` and `role_permission`.

**Never the interface.** The UI reads permissions to decide what to show, as a
courtesy. Hiding a button is not a permission (BR-060).

---

## Operations no client may perform

Distinguished in the bindings, because "no policy exists" and "a policy exists
that refuses everyone" are different states and only one of them is safe.

**`internal`** — performed only by a SECURITY DEFINER function or a migration:
`event` inserts (a client that could write an event could forge history),
`case_number_sequence` allocation, `role_permission` seeding,
`operational_threshold` key changes.

**`forbidden`** — nobody, ever: `event` update and delete (BR-051), `document`
delete (BR-031), `communication` update, and hard deletes everywhere (BR-003,
BR-013, BR-041).

---

## Still open

1. **Should Manager hold `commercial.view`?** The derivation sharpened this from
   a preference into an incoherence: a Manager sets referrer commission terms
   through `person.update` but cannot read them back. Either grant the
   permission or move commission-term entry to Finance. Needs a business answer.
2. **`team` scope** is defined and unused. It needs a reporting hierarchy, which
   nobody has modelled. Not needed at 5–10 users; needed at 30.
3. **Break-glass access.** If the sole Admin leaves, who grants roles? An
   operations question, not a schema one.
