# Database

Schema, migrations and — not yet — policies.

## Status

**The schema exists. The security surface does not.**

`0010_security_defaults.sql` enables row level security on every table and
creates **no policies**, which in Postgres means no client row is visible. Base
tables are revoked from client roles. The schema is deployable and inert:
migrations and SECURITY DEFINER functions work, client sessions see nothing.

That is deliberate. ADR-026 makes views part of the schema contract, and the
policies and masked views are the next unit of work — held back so the schema can
be audited before a security surface is built on top of it.

**Nothing here has been executed.** No Postgres was available in the session that
wrote it, so the SQL is unrun: it has been checked by reading and by the
structural tests in `src/domain/permissions/`, and it has not been checked by a
parser. Standing up a database and running `0001` through `0009` in order is the
first task of the schema audit, before any judgement about the design is worth
making.

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
