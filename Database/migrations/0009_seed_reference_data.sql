-- ===========================================================================
-- 0009 — Reference data
--
-- Hand-written, unlike 0008, and that difference is the point of ADR-025.
--
-- 0008 is generated because its content is CODE: the permission catalog and the
-- threshold key set are owned by src/domain/ and the database is their
-- projection. The rows below are DATA: loan products, document types and
-- rejection categories are maintained by people through master_data.manage, and
-- these values are a starting point rather than a definition.
--
-- Every list here is expected to be wrong in detail and revisable without a
-- deploy. That is the whole reason each of them is a table.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- loan_product — Amaze's own taxonomy (ADR-016)
--
-- Known at case creation, before any bank is chosen, which is what makes the
-- requirement engine possible.
-- ---------------------------------------------------------------------------

insert into loan_product (code, category, variant, display_order) values
  ('hl_purchase',        'Home Loan',     'Purchase',          10),
  ('hl_self_construct',  'Home Loan',     'Self Construction', 20),
  ('hl_plot_purchase',   'Home Loan',     'Plot Purchase',     30),
  ('hl_balance_transfer','Home Loan',     'Balance Transfer',  40),
  ('hl_top_up',          'Home Loan',     'Top-up',            50),
  ('bl_working_capital', 'Business Loan', 'Working Capital',   60),
  ('bl_term_loan',       'Business Loan', 'Term Loan',         70),
  ('bl_overdraft',       'Business Loan', 'Overdraft',         80),
  ('lap',                'LAP',           'Loan Against Property', 90),
  ('pl',                 'Personal',      'Personal Loan',    100)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- document_type (ADR-025)
--
-- owner_kind is what stops a payslip being attached to a property.
-- requires_period is true where "which months?" is part of the document's
-- identity — a bank statement without a period is not a bank statement.
-- ---------------------------------------------------------------------------

insert into document_type (code, name, owner_kind, requires_period, requires_expiry, description, display_order) values
  -- Person: identity
  ('pan_card',          'PAN Card',                 'person',       false, false, 'Primary identity document. PAN is exclusive to one person and near-definitive when read off a document (ADR-013).', 10),
  ('aadhaar_card',      'Aadhaar Card',             'person',       false, false, 'Image only, with the number masked. V1 stores no Aadhaar number and does not use it as a match key (ADR-017).', 20),
  ('address_proof',     'Address Proof',            'person',       false, true,  'Utility bill, rental agreement or similar.', 30),
  ('photograph',        'Photograph',               'person',       false, false, 'Passport-size photograph for the application form.', 40),

  -- Person: income, salaried
  ('salary_slip',       'Salary Slip',              'person',       true,  false, 'Typically the last three months. Period is part of its identity.', 50),
  ('form_16',           'Form 16',                  'person',       true,  false, 'Annual, per assessment year.', 60),
  ('bank_statement',    'Bank Statement',           'person',       true,  false, 'Typically six or twelve months, depending on the lender.', 70),
  ('employment_letter', 'Employment Letter',        'person',       false, false, 'Confirms designation and tenure where the bank asks about job stability.', 80),

  -- Person: income, self-employed
  ('itr',               'Income Tax Return',        'person',       true,  false, 'Per assessment year. The number of years required varies by lender and by business vintage.', 90),
  ('computation_income','Computation of Income',    'person',       true,  false, 'Accompanies the ITR.', 100),

  -- Organisation: borrowing firm (the reason Organisation is an entity, ADR-009)
  ('gst_certificate',   'GST Certificate',          'organisation', false, false, 'Held by a borrowing firm.', 110),
  ('org_itr',           'Firm Income Tax Return',   'organisation', true,  false, 'The firm''s own return, distinct from any individual''s.', 120),
  ('financial_statements','Financial Statements',   'organisation', true,  false, 'Balance sheet and profit-and-loss, per financial year.', 130),
  ('org_bank_statement','Firm Bank Statement',      'organisation', true,  false, 'The firm''s current account.', 140),
  ('business_proof',    'Business Proof',           'organisation', false, false, 'Registration, licence or partnership deed establishing the firm exists.', 150),

  -- Property
  ('sale_deed',         'Sale Deed',                'property',     false, false, 'Belongs to the property, not to any one case — the same deed serves a purchase, a later top-up and a balance transfer (ADR-007).', 160),
  ('encumbrance_cert',  'Encumbrance Certificate',  'property',     true,  false, 'Covers a period, and that period is what a bank checks.', 170),
  ('property_tax_receipt','Property Tax Receipt',   'property',     true,  false, 'Per assessment year.', 180),
  ('approved_plan',     'Approved Building Plan',   'property',     false, false, 'Required for construction-linked lending.', 190),
  ('valuation_report',  'Valuation Report',         'property',     false, true,  'Becomes applicable only once a property is identified — before that, demanding it makes the checklist wrong (Requirements and Progress Part 3).', 200),
  ('legal_opinion',     'Legal Opinion',            'property',     false, false, 'The bank''s panel advocate''s view on title.', 210),

  -- Case: paperwork that genuinely belongs to the application itself
  ('login_form',        'Login Form',               'case',         false, false, 'The bank''s own application form for this file. One of the few genuinely case-owned documents (ADR-007).', 220),
  ('sanction_letter',   'Sanction Letter',          'case',         false, true,  'What the bank issued. Carries the offer''s validity.', 230),
  ('disbursement_memo', 'Disbursement Memo',        'case',         false, false, 'Evidence that money moved.', 240)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- rejection_reason (ADR-028, BR-024, BR-026, BR-027)
--
-- Amaze's standardised categories. Banks describe one refusal in incompatible
-- language — "FOIR exceeded", "obligations high", "IIR norms not met" are one
-- fact — so the bank's own wording is recorded verbatim on the submission and
-- these are what reports group by.
--
-- THIS LIST IS A STARTING POINT, NOT A FINDING. It was derived from the common
-- refusal shapes in Indian retail and SME lending, not from Amaze's own history,
-- which does not exist in structured form yet. Expect it to be revised once a
-- few hundred real rejections have been classified — and revising it is a data
-- change, which is precisely why this is a table (ADR-028).
-- ---------------------------------------------------------------------------

insert into rejection_reason (code, name, description, display_order) values
  ('credit_history',        'Credit history',
   'Low bureau score, past defaults, settlements or write-offs. The most common single category, and the one most worth tracking per branch.', 10),

  ('income_insufficient',   'Income insufficient',
   'Declared or assessed income does not support the requested amount at the lender''s multiple.', 20),

  ('obligations_too_high',  'Existing obligations too high',
   'FOIR / IIR norms not met. Distinct from insufficient income: the income is adequate, the existing EMIs are not.', 30),

  ('vintage_insufficient',  'Employment or business vintage insufficient',
   'Too little time in the current job, or the business is younger than the lender requires.', 40),

  ('documents_incomplete',  'Documents incomplete',
   'The file was not completed within the lender''s window. Distinct from a discrepancy: nothing was wrong, something was missing.', 50),

  ('document_discrepancy',  'Document discrepancy',
   'A document was inconsistent, unverifiable or not accepted. This is the category that matters in a dispute, so the bank''s verbatim wording is especially worth recording.', 60),

  ('banking_unsatisfactory','Banking conduct unsatisfactory',
   'Cheque returns, insufficient average balance, or cash flows that do not support the declared income.', 70),

  ('property_legal',        'Property — legal or title issue',
   'Title defect, unapproved layout, encumbrance, or a chain of documents the panel advocate would not clear.', 80),

  ('property_technical',    'Property — technical or valuation issue',
   'Valuation below the required level, construction deviation, or a property type the lender does not fund.', 90),

  ('age_tenure_mismatch',   'Age or tenure mismatch',
   'The requested tenure runs past the lender''s maximum age at maturity.', 100),

  ('profile_or_area_policy','Profile or area policy',
   'The lender''s internal negative list — an occupation, an industry or a locality it does not serve. Rarely explained by the bank, which is why the verbatim text usually adds nothing here.', 110),

  ('product_not_offered',   'Product not offered',
   'The lender does not serve this product or segment at this branch. Arguably our error rather than a rejection, and tracking it separately is how that becomes visible.', 120)
on conflict (code) do nothing;
