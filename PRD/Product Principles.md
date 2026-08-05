# Product Principles

**Status:** Draft for review.

The tie-breakers. When a feature decision is genuinely arguable, these settle it.

**A principle has to be earned.** Every one below traces to a decision already
made and a problem already identified — the ADR is cited. A principle nobody has
had to apply yet is an aspiration, and aspirations do not settle arguments.
Principles will be added as decisions force them, not invented in advance.

A principle also has to be *capable of losing you something*. "Be fast" is not a
principle; nobody argues for slow. Each of these rules out something a reasonable
person would otherwise build.

---

## 1. Absence is silence

An optional participant that does not exist produces **nothing**: no record, no
placeholder field, no empty panel, no document requirement, no progress penalty,
no workflow step.

The common case — one applicant, no co-applicant, no guarantor, no property yet —
must feel effortless, and must be able to reach 100% complete, because nothing
about it is in fact missing. Complexity appears only when reality supplies it.

*What this rules out:* greyed-out sections, "not applicable" placeholders,
progress bars that can never fill, and forms designed around the most complex
case the schema can represent.
*Source:* ADR-010, ADR-011. `Requirements and Progress.md`.

## 2. Every screen answers one question

- Telecaller — *who should I call next?*
- Login executive — *what is missing before this file can go to the bank?*
- Management — *which cases need my attention today?*

A screen that answers five questions answers none of them well. If a second
question is important, it deserves a second screen.

*What this rules out:* dashboards assembled from whatever data was available.
*Source:* stated requirement; to be developed in `UI Philosophy.md`.

## 3. The model is rich; the interface is not

The data model exists to be correct over ten years. The interface exists to be
usable in ten seconds. These are different jobs and must not be conflated —
schema sophistication is never a reason to show more.

The vocabulary test: users see **Bank**, **Builder**, **Employer**, **Case**.
They never see "Organisation", "Party", "Entity". A screen asking someone to
"select an organisation" has leaked the abstraction, and that is a bug.

*What this rules out:* generic CRUD screens generated from tables.
*Source:* ADR-014.

## 4. Search replaces memory

Nobody should need to remember the correct name of anything. A fragment, a
misspelling, a locality, four digits of a phone number — all must find the
record. The system holds the canonical name so people don't have to.

*What this rules out:* exact-match search, required search filters, separate
search boxes per entity type.
*Source:* ADR-013. `Identity Resolution.md`.

## 5. Information is entered once

A repeat customer's KYC is already on file. A known employer is already known. Any
screen asking for something the system already holds is a defect, and the moment
of recognition — "3 previous cases, KYC on file" — should be shown, because that
is where AOS visibly beats the way things work today.

*What this rules out:* documents owned by cases, employer as free text, and any
per-case re-entry of person-level facts.
*Source:* ADR-006, ADR-007, ADR-009.

## 6. Nothing is lost

Records are archived, merged, deactivated or redirected — never destroyed. Every
state change is an event with an actor. Every override is itself recorded.

*What this rules out:* delete buttons, in-place overwrites, editable history.
*Source:* ADR-005. BR-003, BR-050, BR-053. Subject to the erasure question in
`Business Rules.md`.

## 7. Ambiguity is presented, never resolved silently

When the system is unsure — is this the same person, the same business, the same
property — it shows the candidates and lets a human decide. It never guesses, and
it never blocks. Every automatic resolution has a visible way to disagree.

*What this rules out:* silent auto-merge, and hard "duplicate detected" refusals.
*Source:* ADR-013. `Identity Resolution.md` Parts 3–5.

## 8. Permissions are security; workspaces are usability

*Confirmed. Supersedes "role-based interfaces".*

**Permissions** decide what may happen, and are enforced in the database.
**Workspaces** decide what a screen leads with, and are interface-only. A
workspace never grants or withholds anything.

One person holds several roles and receives the union of their permissions,
because at this size people wear several hats — a login executive who also makes
calls should not need a second login, and two accounts for one human is how audit
trails start lying.

*What this rules out:* separate apps per role, permission logic living in the
navigation menu, and hiding a button in place of denying an action.
*Source:* BR-061, BR-063, BR-064. ADR-022. `Permissions.md`.

## 9. AI is invisible when it saves typing, visible when it affects a decision

*Revises the original "AI is invisible".*

Invisible is right for summarising a thread, extracting fields from a document,
ranking search results. It is wrong for anything touching eligibility or
verification, where the machine's conclusion must be shown, attributable and
overridable — with the disagreement recorded.

*Why the revision:* in lending, an invisible judgement is an unaccountable one.
*Source:* BR-032.

## 10. Form factor follows the work

*Revises the original "mobile-first".*

A telecaller making sixty calls a day needs a dense desktop list and a keyboard.
Management checking sanctions at 9pm needs a phone. Neither is served by a single
blanket rule.

*What this rules out:* one responsive layout stretched across every role.

## 11. Structured before free text

If something is being written into notes repeatedly, it wants a field. Free text
cannot be searched reliably, reported on, or acted upon — a rejection reason
buried in a note is a fact the company cannot learn from.

The converse also holds: a field nobody fills is worse than a note. Structure has
to earn its place.

*Source:* BR-024.

## 12. Every abstraction pays rent

Before any new entity, table or relationship: what operational problem does it
solve today, what expensive migration does it prevent, what complexity does it
add, and is that complexity justified now?

Both failure modes are real. Architecture built for imagined futures is waste.
Under-design that guarantees a rewrite is worse. This document set has already
gone both ways on the same question — see ADR-009, where the original decision
was reversed.

*Source:* stated requirement, applied throughout `DECISIONS.md`.

---

## How to use this

When a feature is proposed, name the principle it serves. If it serves none, that
is a signal. If it violates one, either the feature is wrong or the principle is
— and if it's the principle, change it here, with reasoning, rather than making a
quiet exception. Exceptions accumulate; principles do not.
