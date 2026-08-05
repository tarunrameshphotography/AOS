-- ===========================================================================
-- 0011 — Financial-year-aware document requirements
--
-- Additive only. No existing column, constraint or row is changed in a way
-- that alters current behaviour; everything added here defaults to null / is
-- ignored by anything that does not yet know about it.
--
-- Why this is needed: `document` has carried period_start/period_end since
-- 0005 — a document can already say "this bank statement covers Apr–Sep
-- 2024." `document_requirement` cannot say the equivalent. Today "Income Tax
-- Return" generates exactly one requirement row per case party, so a lender
-- asking for the last two years' returns has no way to be represented: the
-- first ITR uploaded — any year — silently satisfies the single row, and
-- there is no way to record that a second year is still outstanding.
--
-- The fix reuses document's existing period_start/period_end SHAPE rather
-- than inventing a parallel "financial_year" text or enum column — one
-- concept of "period" in the schema, not two. The requirement engine (see
-- src/domain/requirements/financial-year.ts) generates one document_requirement
-- row per required financial year for the document types that need it (GST
-- returns, ITR, balance sheet, profit and loss, bank statements), each row
-- carrying the exact date range for that year. Document types outside that
-- set are unaffected: requires_period on document_type already covers "this
-- document has a period"; this migration only adds the ability for a
-- REQUIREMENT to specify which period it wants, for the subset of types
-- where that period is a financial year and the case may need several.
--
-- Known simplification, not enforced here: nothing at the database level
-- requires satisfied_by_document_id to point at a document whose own period
-- matches the requirement's period. That match is made by the requirement
-- generator and by uploadDocument in the prototype's fake store, which
-- carries the requirement's period onto the document it creates. A trigger
-- could enforce this cross-row invariant, but no Postgres instance has run
-- any migration in this repository yet (Docs/Session Checkpoint.md), and
-- writing an untested trigger alongside a still-pending schema audit is a
-- worse trade than stating the gap plainly. Revisit during that audit.
-- ===========================================================================

alter table document_requirement
  add column period_start date,
  add column period_end   date;

comment on column document_requirement.period_start is
  'The financial year (or other period) this specific requirement row is '
  'for, when the case needs more than one period of this document type — '
  'e.g. two separate rows for ITR FY2024-25 and FY2023-24. Null for document '
  'types that are not financial-year-scoped requirements (PAN, Aadhaar, '
  'address proof, a single rolling-window statement, ...). Mirrors '
  'document.period_start (0005) deliberately: one shape for "period" in the '
  'schema, reused rather than duplicated. src/domain/requirements/'
  'financial-year.ts computes these dates and decides which document types '
  'they apply to.';

comment on column document_requirement.period_end is
  'Paired with period_start; see that column''s comment.';

alter table document_requirement
  add constraint document_requirement_period_ordered
    check (period_end is null or period_start is null or period_end >= period_start);

-- ---------------------------------------------------------------------------
-- New document types this feature was scoped for.
--
-- GST Returns (periodic filings) is distinct from the existing gst_certificate
-- (one-time registration proof) — conflating a registration document with a
-- recurring filing would misrepresent both. Balance Sheet and Profit and Loss
-- are split out of the existing bundled `financial_statements` type so each
-- can be requested, uploaded and verified per financial year independently,
-- matching how lenders actually ask for them as separate exhibits.
--
-- `financial_statements` is deactivated, not deleted (same pattern as
-- rejection_reason, ADR-028/BR-027): the requirement engine stops generating
-- it going forward, but the row and anything that already referenced it
-- remain intact and queryable.
-- ---------------------------------------------------------------------------

insert into document_type (code, name, owner_kind, requires_period, requires_expiry, description, display_order) values
  ('gst_returns',     'GST Returns',                'organisation', true, false,
   'Periodic GST filings (e.g. GSTR-3B, GSTR-1), financial-year scoped. Distinct from gst_certificate, which is the one-time registration proof.', 115),
  ('balance_sheet',   'Balance Sheet',               'organisation', true, false,
   'Per financial year. Split out of the bundled financial_statements type so it can be requested and verified independently of the profit and loss statement.', 131),
  ('profit_and_loss', 'Profit and Loss Statement',   'organisation', true, false,
   'Per financial year. See balance_sheet.', 132)
on conflict (code) do nothing;

update document_type set is_active = false where code = 'financial_statements';

comment on column document_type.is_active is
  'Retired types are deactivated, never deleted, so historic documents and '
  'requirements keep pointing at the type they were recorded under — the '
  'same reasoning as rejection_reason.is_active (BR-027). financial_statements '
  'was retired in 0011, superseded by balance_sheet and profit_and_loss.';
