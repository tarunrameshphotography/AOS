# AOS — Amaze Operating System

The internal operating system for Amaze Loans Pvt Ltd.

One system of record for the loan business: the people involved, the cases, the
documents, the banks, and every event that happens along the way. It replaces
memory, Excel, WhatsApp threads and Windows folders — which is what runs the
company today.

Scope is loans. Not construction, not other ventures.

## Status

**Phase: Implementation. Architecture v1 is frozen.**

Domain layer and database schema written. Policies and views are next, after the
schema audit.

The PRD folder is the source of truth. Code follows the PRD, never the reverse.

## Structure

| Folder      | Contains |
|-------------|----------|
| `PRD/`      | Product requirements. Written before any code. |
| `Design/`   | Wireframes, screen flows, visual system. |
| `Frontend/` | React + TypeScript + Tailwind + shadcn/ui. Empty until PRD is approved. |
| `Backend/`  | Supabase edge functions, n8n workflow definitions. |
| `Database/` | Schema, migrations, RLS policies. |
| `Docs/`     | Operational docs: setup, runbooks, onboarding. |

## PRD reading order

1. `Vision.md` — the north star. One page. *(not yet written)*
2. **`Product Principles.md`** — the tie-breakers. ✅
3. **`Business Rules.md`** — the invariants. Implementation-independent. ✅
4. **`Data Model.md`** — entities and relationships. ✅
5. **`Identity Resolution.md`** — how AOS finds anything from a half-remembered
   fragment. ✅
6. **`Requirements and Progress.md`** — contextual completeness; why an absent
   optional participant never lowers a score. ✅
7. **`Loan Lifecycle.md`** — every stage a case can occupy. ✅
8. **`Workflow.md`** — how a case moves between stages, including edge cases. ✅
9. **`Permissions.md`** — permissions, roles and workspaces. ✅
10. `User Personas.md` — who uses it, and what each role must never see. *(not yet written)*
11. `UI Philosophy.md` — interface rules. *(not yet written)*
12. `Notifications.md` — events separated from delivery channels. *(not yet written)*
13. `Future Ideas.md` — deliberately parked. Not a backlog.

`Docs/Consistency Audit.md` records the last full cross-document audit and its
fixes.

The domain documents were written before Vision deliberately. Vision is easy to
write vaguely; the entity model is not, and doing it first means Vision has to
describe something real.

## Decisions

Architectural decisions are recorded in `DECISIONS.md` at the root, with
reasoning. If you cannot explain why a decision was made, it is not a decision
yet — it is a habit.
