# Session Checkpoint — 2026-08-05

Permission matrix, PRD updates and database schema complete.
**Tree green: `tsc --noEmit` clean, 115 tests passing.**

**Stopped here deliberately. The schema audit is the next task.**

---

## Plan status

| # | Step | Status |
|---|---|---|
| 1 | ADR-024, ADR-025, ADR-026, ADR-027 | ✅ Done |
| 2 | deriveSystemStage bug fix | ✅ Done |
| 3 | Case numbering | ✅ Done |
| 4 | **Complete the permission matrix** | ✅ Done |
| 5 | **Update affected PRD documents** | ✅ Done |
| 6 | **Write the database schema** | ✅ Done |
| 7 | **Schema audit** | ⬜ **Resume here** |
| 8 | Policies and masked views | ⬜ Blocked on the audit |

---

## What exists now

**`src/domain/permissions/`** — the matrix. `scopes.ts`, `actions.ts` (52
permissions), `roles.ts` (5 roles, every grant enumerated and scoped),
`tables.ts` (33 tables, each bound to the permission governing select / insert /
update / delete), `seed.ts` (generates the migration). Tests assert no orphan
tables and no orphan permissions — ADR-027 is enforced, not aspirational.

**`src/domain/settings/thresholds.ts`** — the closed key enum ADR-025 requires.

**`Database/migrations/0001`–`0010`** — the schema. Deployable and **inert**: RLS
is enabled on every table with no policies, base tables revoked from client
roles. See `Database/README.md`.

**`Docs/Permission Matrix.md`** — the readable artefact.

---

## Two ADRs added

- **ADR-028** — Bank rejection reasons are master data, in two layers:
  standardised category (mandatory) plus the bank's verbatim wording (optional).
  Explains why `lost_reason` stays a code enum: our vocabulary lives in code, the
  world's lives in data.
- **ADR-029** — `reference` is the family where `own` is not offered; write
  governance is a separate axis. Extends ADR-027, which defined `reference` in a
  way that excluded `person`.

---

## Awaiting a decision

Four grants were chosen by the engineer, not the business. Each is a one-line
change in `roles.ts` plus a re-seed. Detailed in `Docs/Permission Matrix.md`.

1. Login Executive holds `case.update:all` (ADR-027, previously flagged).
2. `offer.accept` granted to Login Executive and Manager — it was assigned to
   nobody, which made the Workflow's withdraw-the-others behaviour unreachable.
3. Finance gained `person.read:all` and `organisation.read:all`.
4. **Admin lost `document.read`, `communication.read` and `note.read`** — the
   largest of the four. Enumerating "all read permissions at `all`" forced the
   question of whether administering the system includes reading the customers.
   The line drawn is *structure, not content*.

---

## Still needing a business answer

1. **Hold semantics** — may a held case transition; does marking lost clear the
   hold. Now the last workflow gap the schema cannot decide for itself. The
   columns exist; the guard does not. Recorded in `PRD/Workflow.md`.
2. **Does Manager hold `commercial.view`?** Sharpened from a preference into an
   incoherence: commission terms are written under `person.update` and read under
   `commercial.view`, and no role holds both.
3. Carried over: retention periods, login fees, referrer commissions, per-bank
   checklists, partial disbursement.

---

## The one thing the audit must do first

**No SQL in `Database/` has been executed.** No Postgres or Docker was available
in the session that wrote it. It is checked by reading and by the structural
tests; it is not checked by a parser.

Stand up a database and run `0001` through `0009` in order before forming any
judgement about the design. Specific things to look at hardest:

- `app.current_user_id()` calls `auth.uid()`, which exists on Supabase and not in
  plain Postgres. `check_function_bodies` will reject it on a bare instance.
- `max(rp.scope)` in `app.scope_of` relies on `max(anyenum)`.
- The deferred constraint trigger for BR-023.
- The partial unique indexes carrying BR-010, BR-022 and BR-025.
- Whether the reconciling deletes in `0008` behave on a re-run, not just on an
  empty database.
