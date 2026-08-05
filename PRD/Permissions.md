# Permissions

**Status:** Draft for review.

Who may do what, and where that is enforced.

---

## Three independent concepts

Conflating any two of these produces a system that is either insecure or
unusable. They are kept separate deliberately.

| Concept | Answers | Exists for | Enforced where |
|---|---|---|---|
| **Permission** | May this action happen? | Security | Database (RLS) |
| **Role** | Which permissions does this person hold? | Administration | Data, assignable at runtime |
| **Workspace** | What does this person see first? | Usability | Interface only |

**A workspace never grants or withholds access.** It decides what a screen leads
with. Someone in the Telecaller workspace who holds manager permissions still has
them — they are simply looking at a calling-oriented view. Hiding a button is not
a permission (BR-060); a workspace hides buttons, and that is all it does.

A user holds **many roles at once** and receives the **union** of their
permissions. At this size people wear several hats — a login executive who also
makes calls needs one account, not two. Two accounts for one human is how audit
trails start lying.

---

## Permission = action + scope

An action alone is not enough. "May they read cases?" has no useful answer; "may
they read *which* cases?" does.

Every permission is a pair:

```
case.read : own | team | all
```

| Scope | Means |
|---|---|
| `own` | Rows where the user is the owner, or a named participant |
| `team` | Rows owned by anyone reporting to the user |
| `all` | Every row |

Scopes are ordered — `all` implies `team` implies `own` — so a check is a
comparison, not a set membership test. This is what RLS policies compile down to,
and it is why scope must exist in the model rather than being improvised per
table.

`team` is defined but **unused in V1**: there is no reporting hierarchy yet. It
exists because adding a scope later means revisiting every policy, whereas
leaving one unused costs nothing. This is the one piece of forward-design in this
document, and it is deliberate.

**Every permission carries a scope, always** (ADR-027). Where narrowing is
impossible — `case.create` has no row to scope against — or deliberately not
offered — `person.read`, because recognition requires seeing everyone — the
scope is the sentinel `all`. This is what makes BR-064 literally true rather
than mostly true.

---

## The permission catalog

**Defined in `src/domain/permissions/actions.ts`, and enumerated in full with
every role's grant in `Docs/Permission Matrix.md`.** That document is derived
from the code; this section describes the catalog's shape and the decisions
behind it, and does not restate the list — one rule, one implementation.

The catalog is **derived from the entity list**, not accumulated from screens
(ADR-027). Tests assert that no table lacks a permission binding and no
permission lacks a target, so the completeness claim is checked rather than
asserted.

Grouped by entity. Names are `entity.action` — no abbreviations, and no wildcard
notation, because a `task.*` shorthand makes "who can assign tasks?" unanswerable
by reading the document.

| Group | Covers |
|---|---|
| **Cases** | read, create, update, assign, hold, mark_lost, reopen, close |
| **People and organisations** | person, organisation, property and employment — read, create, update, merge, and `person.override_duplicate` |
| **Documents and requirements** | document read, upload, verify, delete_version; `requirement.waive` |
| **Banking** | submission read, create, update_status; offer read, record, accept |
| **Work and communication** | task read, create, update, assign; communication read and log; note read and create |
| **Sensitive** | `identifier.view_full`, `commercial.view`, `event.view` |
| **Administration** | `user.read`, `user.manage`, `role.assign`, `master_data.read`, `master_data.manage`, `report.view` |

### What the derivation added

The audit found five permissions simply missing, because the catalog had grown
from the screens somebody had thought about: `property.*`, `employment.*`,
`organisation.update`, `communication.read` and `note.read`. Completing it added
two more:

- **`master_data.read`**, held by every role. It exists so that no table binds to
  a null permission — "everyone may read this" is a decision, and it should be
  written down as one.
- **`property.merge`**, from `Identity Resolution.md` Part 5, which requires
  merging properties to be possible, rare, and extra-confirmed.

### Sensitive data is column-level, and only twice

`identifier.view_full` and `commercial.view` hide *columns* on rows the user is
otherwise entitled to see, so they cannot be RLS policies. They are masking
expressions in the views clients read (ADR-026). Exactly two permissions work
this way, and a test asserts it stays two.

`event.view` is in the sensitive group but is row-level: an event is either yours
to see or it is not.

---

## Roles

Five. Each is a bundle of permissions, assignable at runtime.

**Every grant, for every role, is enumerated in `Docs/Permission Matrix.md`** and
defined in `src/domain/permissions/roles.ts`. What follows is what each role is
*for*, and the decisions that shaped it. The enumeration is not repeated here,
because a list maintained in two places is a list that disagrees with itself.

### Telecaller
Works a call list. Creates leads, talks to people, books appointments.

The shape that matters: **cases are `own`, people are `all`.** A telecaller must
be able to discover that a caller is an existing customer — that recognition is
the core promise of the product (Principle #4). What they cannot do is browse a
colleague's cases.

Notably **not**: `document.verify`, `requirement.waive`, `identifier.view_full`,
`commercial.view`, `event.view`.

### Login Executive
Prepares files and deals with banks.

Almost everything at `all`, because the login desk works whatever file is in
front of it regardless of who sourced the lead. That is necessary rather than
generous. It stops at ownership decisions — hold, mark lost and reopen stay
`own`.

Holds `case.update:all`. **This is the engineer's call, not the business's**
(ADR-027): a desk holding `document.verify` and `submission.create` at `all` but
unable to correct the requested amount on the file it is submitting is
incoherent. Flagged so it can be reversed by decision rather than discovered by
accident.

### Manager
Sees everything operational, assigns work, resolves identity problems. Adds
judgement rather than reach: assignment, merges, task allocation, reporting, the
audit log.

Not `case.close` — that is Finance, because closing asserts the invoice is
raised.

Not `commercial.view` by default. The derivation sharpened this from a preference
into an incoherence: a Manager sets referrer commission terms through
`person.update` but cannot read them back. See the open questions.

### Finance
Money. Deliberately narrow elsewhere.

Reads cases, closes them, sees commercial figures, reads reports. No
`case.update`, no `document.verify`, no documents at all. Finance closes cases
because closing means the invoice is raised (Loan Lifecycle: `Disbursed →
Closed`).

Holds `person.read:all` and `organisation.read:all`, which this document did not
previously grant — `case.read:all` alone renders a case with no applicant name,
which is not a usable screen.

### Admin
Runs the system, not the business.

This role previously ended with the prose wildcard "all read permissions at
`all`". ADR-027 requires that be enumerated, and enumerating it forces a question
the wildcard hid: **which reads are administering the system, and which are
reading the customers?**

The line is **structure, not content**. Admin may see that a case exists, who
owns it, what stage it is at, and what happened to it — enough to answer "why can
this user not see that case?". Admin may not open the customer's documents, calls
or notes.

Excluded deliberately: `identifier.view_full` and `commercial.view` (ADR-027),
and — added by the derivation — `document.read`, `communication.read` and
`note.read`. The first of those is load-bearing: excluding `identifier.view_full`
while granting `document.read` would be theatre, because the PAN card image is in
the document store and a masked PAN column would protect nothing.

Also no `case.update` and no `document.verify`. Administering the system is not a
licence to alter operational records. An admin who needs to work cases holds a
second role explicitly — which is exactly what multiple roles are for, and it
leaves a trail.

---

## Workspaces

The interface a user lands in. Independent of permissions.

| Workspace | Answers | Default for |
|---|---|---|
| **Calling** | Who do I call next? | Telecaller |
| **Login Desk** | What is missing before this file goes to the bank? | Login Executive |
| **Management** | Which cases need attention today? | Manager |
| **Finance** | What is owed, and what is collected? | Finance |
| **Administration** | Is the system healthy? | Admin |

Rules:

- A user may switch between any workspace their roles make meaningful.
- Switching workspace **never** changes what they are permitted to do.
- A user with one role never sees a workspace switcher at all — the concept stays
  invisible to the people who don't need it.

---

## Enforcement

**Primary: the database.** Every table carries RLS policies derived from this
document. A query that should return nothing returns nothing, regardless of which
code path issued it.

Row visibility is RLS on the base table. **Column visibility is a masked view,
and clients read the view, never the base table** (ADR-026). Base tables are
revoked from client roles, so every read path goes through a view and views are
part of the schema contract. Writes go to base tables through the domain layer,
which is where they belonged anyway.

Both mechanisms consult one SECURITY DEFINER function,
`app.has_permission(action, scope)`, which is the only reader of `user_role` and
`role_permission`.

Every table names the permission governing each of select, insert, update and
delete, in `src/domain/permissions/tables.ts` (ADR-027). Tables with no
permission of their own bind to their parent's — `case_party` is governed by
`case.read` / `case.update` — which is a permission model, not an absence of one.
**A table with no binding is a test failure, not an unprotected table that
ships.**

**Secondary: the domain layer.** The permission catalog is defined once in
`src/domain/permissions/`, and the database is seeded from it by migration. It is
not restated in SQL by hand — one rule, one implementation. Policies reference
the seeded tables.

**Never: the interface.** The UI reads permissions to decide what to show, as a
courtesy. It is not a control.

### One denial is recorded

*Narrowed. This section previously claimed a denied attempt at anything in the
sensitive group writes an event. Under masking that is not implementable, and
claiming it would be worse than not having it.*

Where a value is masked there is **no attempt and no denial** — the reader
receives a masked value and nothing happens. There is nothing to record.

The exception is `identifier.view_full`, and it is the only one that matters:
revealing a full PAN is a **per-record disclosure decision** rather than a
whole-surface one. `app.reveal_identifier(identifier_id)` is the sole path to a
full value, and it always writes an event — granted or denied.

For `commercial.view` and `event.view`, "denial" is simply absence from a screen.
Inventing an event for it would mean logging every page load, which produces
noise rather than an audit trail.

The original reason for recording denials still holds and is served by the one
that remains: a pattern of denials usually means the permission model is wrong
and someone is being blocked from their actual job.

---

## Answers to previously open questions

Proposed, with reasoning. These are recommendations, not settled.

**Who may waive a requirement?** Login Executive and Manager. The login executive
is the person who actually knows the RM said "send it, we'll collect the payslip
later" — routing that through a manager would create a bottleneck at exactly the
moment speed matters. Safety comes from every waiver being attributed, reasoned
and reviewable (BR-035), not from making it rare.

**Who may merge people or organisations?** Manager and Admin only. Merging is
consequential and hard to notice when wrong. It is also reversible (BR-005),
which is what makes restricting it to two roles tolerable rather than obstructive.

**Who may mark a case lost?** The case owner, at any stage. I considered requiring
manager approval for losses after sanction, and rejected it: it would add a step
at the moment a telecaller is already having a bad conversation, and the data is
just as good if the loss is recorded promptly and reviewed after. A manager
reviewing losses weekly beats a manager gating them.

**Who may close a case?** Finance. Closing asserts the invoice is raised.

---

## Open questions

1. **Should Manager hold `commercial.view`?** Commission and referrer payout
   figures are commercially sensitive even internally. Excluded by default above;
   easy to grant. **Now more than a preference:** commission terms are written
   under `person.update` and read under `commercial.view`, and no role holds
   both. Either grant Manager the read, or move commission-term entry to Finance.
   Needs a business answer.
2. **`document.delete_version`** is in the catalog but assigned to nobody.
   Documents are versioned and never overwritten (BR-031), so deletion should
   probably not exist at all. It is listed so the decision is explicit rather than
   accidental, and a test asserts the reason is recorded. Recommendation: leave
   unassigned.
3. **Break-glass access.** If the sole Admin leaves, who grants roles? Needs a
   documented recovery procedure, which is an operations question rather than a
   schema one.
4. **Reporting hierarchy.** `team` scope is defined but unusable until someone
   models who reports to whom. Not needed at 5–10 users; will be needed at 30.
