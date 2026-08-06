-- ===========================================================================
-- 0017 — Lending Product Refinement (Milestone 7.1)
--
-- The Lending Product Catalogue (0015/0016) is correct but reads like it was
-- designed from an ER diagram: "Loan Category" and a flat Active/Inactive
-- flag. This migration makes three targeted, additive changes so the
-- catalogue reads the way a loan consultant talks, without touching the
-- three-layer architecture ADR-032 already established.
--
-- 1. RENAME loan_category to customer_product. No new table, no new column
--    on loan_product beyond the renamed FK. `loan_category` already IS what
--    a telecaller calls a "Customer Product" — Home Loan, Business Loan, LAP
--    — grouping several lending products underneath it (Purchase, Self
--    Construction, Balance Transfer...). The milestone brief's Part 1 asked
--    to "design this cleanly, do not duplicate data, keep Bank Products
--    independent" — which is exactly what ADR-032's existing hierarchy
--    already does. Renaming it is the whole change; rebuilding it would
--    duplicate data the brief explicitly warned against.
--
--        customer_product   Amaze's commercial grouping        "Home Loan"
--             |              a telecaller recognises first
--             v
--        loan_product       Amaze's bank-independent product   "Purchase"
--             |              — unchanged, still the "Lending
--             v               Product" ADR-032 named
--        bank_product       one lender's version of it         "HDFC ..."
--             (unchanged, independent — 0003)
--
--    Plain ALTER TABLE / ALTER COLUMN RENAME: no data moves, every existing
--    row, id and foreign key survives untouched.
--
-- 2. Product availability becomes a three-state lifecycle rather than a
--    boolean: Active, Temporarily Suspended, Retired. `is_active` is kept —
--    every existing reader that filters on it keeps working — and a check
--    constraint pins it to the new column so the two can never disagree:
--    `is_active` is true if and only if `availability_status = 'active'`.
--    A plain text column with a check constraint, not a new master-data
--    table: this is a fixed, three-value operational state tied to code (the
--    is_active sync, the domain layer's lifecycle logic), the same reasoning
--    0012's closing summary used to keep case_stage and its siblings as
--    enums rather than tables — a genuine code-and-review decision, not a
--    data-entry list a business user extends.
--
-- 3. Two business-facing, informational-only text columns: who typically
--    takes this product (`typical_customer_profile`), and what is usually
--    asked for (`typical_documents_summary`). Both are free text, deliberately
--    NOT structured data — the milestone brief is explicit that this is
--    guidance for a human reading the catalogue, not the Document
--    Requirement Engine (a future, separate milestone that will generate
--    exact requirements from the fields 0015 already added).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Part 1 — rename, not rebuild.
-- ---------------------------------------------------------------------------

alter table loan_category rename to customer_product;
alter table customer_product rename constraint loan_category_code_shape to customer_product_code_shape;
alter trigger loan_category_touch on customer_product rename to customer_product_touch;

alter table loan_product rename column loan_category_id to customer_product_id;
alter index loan_product_category_idx rename to loan_product_customer_product_idx;

comment on table customer_product is
  'What a telecaller or loan consultant thinks of first — Home Loan, Business '
  'Loan, LAP — grouping the lending products underneath it. Formerly named '
  'loan_category (0012); renamed, not rebuilt, because it already modelled '
  'exactly this (Milestone 7.1, ADR-033). Master data since ADR-030.';

comment on column loan_product.customer_product_id is
  'Which customer product this lending product sits under — e.g. "Purchase" '
  'sits under "Home Loan". Was loan_category_id (0012); renamed in Milestone '
  '7.1 (ADR-033) to match how office staff and telecallers actually think '
  'about the catalogue.';

-- ---------------------------------------------------------------------------
-- Part 2 — availability lifecycle.
-- ---------------------------------------------------------------------------

alter table loan_product add column availability_status text not null default 'active';

alter table loan_product add constraint loan_product_availability_status_shape
  check (availability_status in ('active', 'temporarily_suspended', 'retired'));

update loan_product set availability_status = 'retired' where not is_active;

alter table loan_product add constraint loan_product_availability_consistent
  check (is_active = (availability_status = 'active'));

comment on column loan_product.availability_status is
  'Active, Temporarily Suspended, or Retired — richer than is_active alone. '
  'Suspended means "off the panel for now, expected back" (a lender has '
  'paused a scheme); retired means "gone for good" and pairs with '
  'effective_to as before. is_active is kept and pinned to this column by a '
  'check constraint (true iff active), so every existing reader that only '
  'knows is_active still sees the correct on/off answer. Milestone 7.1, '
  'ADR-033.';

-- ---------------------------------------------------------------------------
-- Part 3 — business-facing guidance, informational only.
-- ---------------------------------------------------------------------------

alter table loan_product add column typical_customer_profile text;
alter table loan_product add column typical_documents_summary text;

comment on column loan_product.typical_customer_profile is
  'Who normally takes this product, in the words office staff use — '
  '"Salaried Employee", "Textile Unit", "NRI". Informational only: NOT an '
  'eligibility rule, and never read by the borrower_type / employment_type / '
  'business_constitution junctions that already do that job declaratively. '
  'Milestone 7.1.';

comment on column loan_product.typical_documents_summary is
  'A short, human-readable list of what is usually asked for — "PAN, '
  'Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months)". Guidance for a '
  'person reading the catalogue, not a requirement template: there is still '
  'no loan_product -> document_type table here, and generating exact '
  'requirements from data remains the Document Requirement Engine milestone. '
  'Milestone 7.1.';
