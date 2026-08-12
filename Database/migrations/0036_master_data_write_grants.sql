-- ===========================================================================
-- 0036 — aos_app can write the master data screens it has always been able
-- to read
--
-- THE GAP. Migration 0033 granted aos_app SELECT-only on document_type,
-- document_requirement_rule, operational_threshold and rejection_reason,
-- with a comment explaining why that was correct then: "there is no
-- master-data administration surface in the API, so this is not a
-- restriction on anything that currently happens." That was true in Stage 4
-- Item 3. It stopped being true in Stage 4 Item 4 (commit c91fc70), which
-- gave Document Rules, Document Types, Rejection Reasons and Thresholds real
-- UPDATE routes in Backend/master-data.ts. Nobody had run the application as
-- aos_app against real data since — every install still connected as
-- `postgres` (Docs/Installation.md §5a not yet done anywhere) — so a
-- superuser bypassing every grant meant the gap was invisible until the
-- Office Server Production Cutover Gate's own live verification against a
-- running aos_app connection surfaced it as a real 500 ("permission denied
-- for table document_requirement_rule") on the Document Rules screen.
--
-- WHY UPDATE ONLY, NOT INSERT OR DELETE. Every write in Backend/master-data.ts
-- against these four tables is an UPDATE — editing a rule's applicability, a
-- document type's description, a rejection reason's name, a threshold's
-- value, or flipping is_active. None of the four is ever created or removed
-- through the API; the master-data vocabulary is closed and additive-only
-- through migrations (Database/README.md's "generated migration" discipline
-- for 0008, and 0022/0023/0026/0027/0035 for the rule pack specifically).
-- Granting INSERT or DELETE here would authorise something no route exists to
-- do, which is exactly the kind of unused privilege 0033 itself avoided
-- everywhere else.
--
-- WHY NOT document_requirement_rule_condition. Nothing in Backend/master-data.ts
-- writes it, and the Document Rules screen says so in its own copy:
-- "Conditions are not edited here. Changing when a rule fires is a different
-- decision from changing what it asks for." It keeps the SELECT-only grant
-- 0033 already gave it.
--
-- Additive only, as every migration since 0021: a GRANT, nothing dropped, no
-- row touched, no policy changed (RLS on these four tables already reads
-- "app.current_user_id() is not null" and is unaffected by widening the ACL
-- an authenticated aos_app connection was already subject to).
-- ===========================================================================

grant update on
  document_type,
  document_requirement_rule,
  operational_threshold,
  rejection_reason
to aos_app;
