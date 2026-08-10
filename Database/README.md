# Database

Schema, migrations and — not yet — policies.

## Status

The schema exists and has been executed. `0033_application_role.sql` closed the
gap this section used to describe.

**What was true until Stage 4 Item 3, and is worth recording.** `0010` enabled
row level security on 62 tables and created **no policies**, and this file
described that as a deliberate, inert deny-everything default. It was neither
deny-everything nor inert, because of a fact recorded nowhere: the application
connected as `postgres` — `rolsuper`, `rolbypassrls`, and the owner of every
table. A superuser bypasses RLS unconditionally, `FORCE` included. So the
security surface was not merely unbuilt; the part that appeared to exist was
doing nothing, and the obvious remedy (point `AOS_DB_USER` at an ordinary role)
would have made every query return zero rows with no error.

**What is true now.** `0033` creates `aos_app`: `NOSUPERUSER`, `NOBYPASSRLS`,
owning nothing, granted `DELETE` on no table, and granted `INSERT`/`SELECT` but
not `UPDATE` on `event`. Every RLS-enabled table has a policy — verified by
`Backend/security.test.ts`, which fails the build if a future migration adds a
table and forgets one. The exception is `case_number_sequence`, which has no
policy *and* no grant, because only `app.allocate_case_number()` (SECURITY
DEFINER) may touch it.

**What the policies do and do not do.** Two tiers. The login path (`app_user`,
`api_session`, `person`, `user_role`, `user_permission_override`, `permission`,
`role_permission`) is readable without an identity, because reading it is how an
identity comes to exist. Everything else requires `app.current_user_id()` to be
non-null — an authenticated, *active* employee published into the transaction.

That is a boundary around the connection, not around the user. **RLS in AOS
does not enforce per-user or per-case access and must not be described as
doing so.** Ownership is decided in `Backend/authorize.ts` and proven in
`Backend/api.test.ts`; ADR-022 exists to keep that answered once. What tier B
buys is concrete and narrower: someone holding the `aos_app` password but not
inside an authenticated AOS transaction — a leaked `.env`, a `psql` session
from another PC on the office LAN — reads no customer, case, document or
submission row.

**The office still connects as `postgres` until someone changes it.** `0033`
creates the role with no password, so it cannot authenticate and nothing
changes until an administrator sets one and edits `.env`. See
`Docs/Installation.md` §5a.

ADR-026's masked views remain unbuilt. Column masking is still a real gap and
is not what this migration addressed.

## Migration order

| File | Contains |
|---|---|
| `0001_foundation.sql` | Schemas, extensions, enums, shared triggers |
| `0002_identity_and_access.sql` | person, identifiers, aliases, app_user, roles, the permission catalog |
| `0003_organisations_and_reference.sql` | organisation, branches, lender/referrer profiles, employment, property, reference tables |
| `0004_cases.sql` | case_number_sequence, loan_case, case_party, case_property, number allocation |
| `0005_documents_and_requirements.sql` | document, document_requirement |
| `0006_banking.sql` | submission, submission_query, offer |
| `0007_work_and_events.sql` | task, communication, note, event |
| `0008_seed_permissions.sql` | **Generated.** Permission catalog, role grants, thresholds |
| `0009_seed_reference_data.sql` | Loan products, document types, rejection reasons |
| `0010_security_defaults.sql` | `app.has_permission()`, RLS enabled, base tables revoked |
| `0011`–`0032` | Master data, lending products, lenders, document rules, submissions, employee authentication, sessions |
| `0033_application_role.sql` | `aos_app`, least-privilege grants, the RLS policies |

They must run in order. The dependencies are real: `app_user` cannot exist before
`person`, and the permission seed cannot run before the tables it fills.

## The generated migration

`0008_seed_permissions.sql` **is not edited by hand.** ADR-022 requires the
permission catalog to be defined once in `src/domain/permissions/` and the
database seeded from it — hand-writing a hundred and fifty inserts is exactly the
drift it forbids.

To change a grant:

```
# edit src/domain/permissions/roles.ts
npm run seed:permissions
# commit both
```

`seed.test.ts` fails if the migration and the catalog disagree, so forgetting the
regeneration breaks the build rather than the security model.

The seed is idempotent and **reconciling**, not additive: a grant removed from
`roles.ts` is deleted from the database. A revocation that silently did nothing
would be the worst possible failure for that file.

## Naming

Two tables are not named after their domain concept, both because the natural
name is reserved in SQL:

| Domain | Table |
|---|---|
| case | `loan_case` |
| user | `app_user` |

Quoting a reserved word in every policy is a typo waiting to happen, and
`loan_case` is in any event the more honest name — ADR-002 says the vocabulary
should be concrete.

## Where each kind of rule lives

Stated once, because it decides where every future rule goes.

**The database enforces state invariants** — what must be true of stored data at
commit. Uniqueness (one primary applicant, one disbursed submission, one accepted
offer per submission), exclusivity (a document has exactly one owner; a
case_party is a person or an organisation and the role decides which), presence
(a rejection has a category; a waiver has a reason and a name), and immutability
(the event log, the case number).

**The domain layer enforces transitions** — which moves are legal from where, and
why a refusal happened in words a user can act on. `src/domain/case/transitions.ts`
is authoritative for that and is not restated in SQL.

These are not two implementations of one rule. `sanctionHasOffer` refuses the
move and explains why; the constraint trigger refuses the resulting *state*
however it was reached, including by a path nobody has written yet.

A rule that is only a transition guard is not enforced in the database. A rule
that is only a stored-state fact is not restated in the domain layer.

## Every table answers four questions

`COMMENT ON TABLE` carries them, so they live in the database rather than in a
document that drifts from it: why does this table exist, what business rule
requires it, which ADR introduced it, and which PRD depends on it. A test in
`src/domain/permissions/schema-coverage.test.ts` fails if a table has no comment,
and another fails if a table exists with no permission binding (ADR-027, BR-065).
