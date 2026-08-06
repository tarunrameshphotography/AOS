-- ===========================================================================
-- 0018 — Seed refinement for Milestone 7.1
--
-- Hand-written data, like 0016 (ADR-025) — not a schema change. Three things:
--
--   1. typical_customer_profile and typical_documents_summary for every
--      lending product 0016 seeded, in the office-staff language the
--      milestone brief asked for. Informational only, per Part 3 and Part 4
--      of the brief — neither column is read by the borrower_type /
--      employment_type / business_constitution eligibility junctions, which
--      remain the declarative source of truth.
--
--   2. Coimbatore-first ordering. Amaze's stated footprint is Coimbatore,
--      Tiruppur and Erode (0014) — an engineering, textile, pumps, foundry
--      and transport ecosystem more than a metros-first one. Business Loan
--      moves ahead of Home Loan in customer_product.display_order; nothing
--      else in the category order changes, and no lending product's own
--      display_order changes, only the grouping a telecaller sees first.
--
--   3. A handful of description edits (not rewrites) on products the
--      Coimbatore business community actually uses, naming the local
--      industries the milestone brief gave as examples. No product is added
--      or renamed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Coimbatore-first ordering — Business Loan ahead of Home Loan. Loan Against
-- Property, Personal Loan and the rest keep their existing order (0013):
-- Amaze's own hierarchy already put LAP and Personal Loan after the top two,
-- and nothing in the milestone brief asks to relitigate that.
-- ---------------------------------------------------------------------------

update customer_product set display_order = 10 where code = 'business_loan';
update customer_product set display_order = 20 where code = 'home_loan';

-- ---------------------------------------------------------------------------
-- Description refinements — Coimbatore examples named where the milestone
-- brief called them out (engineering/manufacturing, pumps, foundries,
-- textile, transport, educational institutions, healthcare). Existing
-- description text is extended, not replaced, so nothing that reads it for
-- meaning (not display) sees a different product.
-- ---------------------------------------------------------------------------

update loan_product set description =
  'A revolving limit against stock and receivables, drawn and repaid as the business cycle requires. Renewed annually against a stock statement and audited financials, not repaid in EMIs. The standard facility for Coimbatore''s pump, foundry and textile units financing raw material and work-in-progress.'
  where code = 'bl_working_capital';

update loan_product set description =
  'Term or composite finance to a registered MSME, collateral-free under the CGTMSE guarantee scheme. Needs Udyam registration; the guarantee replaces the security a lender would otherwise ask for. Common among Coimbatore''s smaller engineering and job-work units taking their first formal credit line.'
  where code = 'bl_msme_cgtmse';

update loan_product set description =
  'Finance for goods or passenger commercial vehicles, assessed on the transport business''s route and earnings rather than on salary. Coimbatore and Tiruppur''s transport operators moving textile and engineering goods are the core market for this product.'
  where code = 'vl_commercial_vehicle';

update loan_product set description =
  'Mortgage of a shop, office, godown or industrial unit. Lower funding ratio and tighter valuation than residential LAP. Frequently taken against a factory shed or godown by a Coimbatore engineering or textile business raising working-capital margin.'
  where code = 'lap_commercial';

update loan_product set description =
  'Unsecured lending to a qualified professional — doctor, chartered accountant, architect, engineer — priced off the qualification and practice vintage rather than off collateral. A steady draw among Coimbatore''s doctors and chartered accountants setting up or expanding a practice.'
  where code = 'pl_professional';

-- ---------------------------------------------------------------------------
-- Typical customer profile and typical documents summary, per product.
-- ---------------------------------------------------------------------------

update loan_product v set
  typical_customer_profile = t.profile,
  typical_documents_summary = t.docs
from (values
  ('hl_purchase',          'Salaried Employee, Self-Employed Professional',
                           'PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Sale Agreement, Property Documents'),
  ('hl_self_construct',    'Salaried Employee, Self-Employed Professional owning a plot',
                           'PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Approved Plan, Estimate, Property Documents'),
  ('hl_plot_purchase',     'Salaried Employee, Self-Employed Professional',
                           'PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Sale Agreement, Property Documents'),
  ('hl_plot_construction', 'Salaried Employee, Self-Employed Professional',
                           'PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Sale Agreement, Approved Plan, Property Documents'),
  ('hl_improvement',       'Salaried Employee, existing Homeowner',
                           'PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Estimate, Property Documents'),
  ('hl_extension',         'Salaried Employee, existing Homeowner',
                           'PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Approved Plan, Estimate, Property Documents'),
  ('hl_balance_transfer',  'Salaried Employee, Self-Employed Professional with an existing home loan',
                           'PAN, Aadhaar, Existing Loan Statement, Foreclosure Letter, Bank Statement (6 Months), Property Documents'),
  ('hl_top_up',            'Existing Home Loan Customer',
                           'PAN, Aadhaar, Existing Loan Statement, Bank Statement (6 Months), Property Documents'),
  ('hl_nri',               'NRI',
                           'Passport, Visa, Overseas Income Proof, NRE/NRO Bank Statement (6 Months), Power of Attorney, Property Documents'),
  ('hl_affordable',        'Salaried Employee (Informal Income), Self-Employed with modest income',
                           'PAN, Aadhaar, Income Proof or Self-Declaration, Bank Statement (6 Months), Property Documents'),
  ('bl_working_capital',   'MSME Manufacturer, Textile Unit, Trading Firm',
                           'PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Stock Statement, Financial Statements'),
  ('bl_overdraft',         'MSME Manufacturer, Retail Shop, Trading Firm',
                           'PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Property Documents'),
  ('bl_term_loan',         'MSME Manufacturer, Textile Unit, Retail Shop',
                           'PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Project Report, Property Documents'),
  ('bl_unsecured',         'Retail Shop, Trading Firm, Small Business Owner',
                           'PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months)'),
  ('bl_machinery',         'MSME Manufacturer, Textile Unit, Engineering Workshop',
                           'PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Machinery Quotation, Udyam Registration'),
  ('bl_msme_cgtmse',       'MSME Manufacturer, Textile Unit',
                           'PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Udyam Registration'),
  ('bl_mudra',             'Micro Enterprise, Retail Shop, Small Trader',
                           'PAN, Aadhaar, Business Proof, Bank Statement (6 Months)'),
  ('bl_bill_discounting',  'MSME Manufacturer, Trading Firm supplying larger buyers',
                           'PAN, Aadhaar, GST, Invoices/Bills, Buyer Acceptance, Bank Statement (6 Months)'),
  ('bl_non_fund_based',    'MSME Manufacturer, Contractor, Trading Firm',
                           'PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Contract or Tender Document'),
  ('lap',                  'Salaried Employee, MSME Manufacturer, Retail Shop owner',
                           'PAN, Aadhaar, Income Proof or GST/ITR, Bank Statement (12 Months), Property Documents'),
  ('lap_commercial',       'MSME Manufacturer, Textile Unit, Trading Firm',
                           'PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Property Documents'),
  ('lap_lrd',              'Property Owner with a leased commercial property',
                           'PAN, Aadhaar, Registered Lease Deed, Tenant KYC, Bank Statement (12 Months), Property Documents'),
  ('lap_balance_transfer', 'Existing LAP Customer, MSME Manufacturer',
                           'PAN, Aadhaar, Existing Loan Statement, Foreclosure Letter, Bank Statement (12 Months), Property Documents'),
  ('pl',                   'Salaried Employee',
                           'PAN, Aadhaar, Salary Slips (3 Months), Bank Statement (6 Months), Form 16'),
  ('pl_self_employed',     'Self-Employed Professional, Small Business Owner',
                           'PAN, Aadhaar, ITR (2 FY), Bank Statement (12 Months)'),
  ('pl_professional',      'Doctor, Chartered Accountant, Architect, Engineer',
                           'PAN, Aadhaar, Qualification Proof, ITR (2 FY), Bank Statement (12 Months)'),
  ('vl_new_car',           'Salaried Employee, Self-Employed Professional',
                           'PAN, Aadhaar, Income Proof, Bank Statement (3 Months), Vehicle Quotation'),
  ('vl_used_car',          'Salaried Employee, Self-Employed Professional',
                           'PAN, Aadhaar, Income Proof, Bank Statement (3 Months), Vehicle RC, Valuation Report'),
  ('vl_two_wheeler',       'Salaried Employee, Student with a co-applicant',
                           'PAN or Aadhaar, Income Proof or Co-applicant Income Proof, Vehicle Quotation'),
  ('vl_commercial_vehicle','Transport Operator, Logistics Firm',
                           'PAN, Aadhaar, Route Permit, Bank Statement (6 Months), Vehicle Quotation'),
  ('gl_gold',              'Salaried Employee, Retail Shop owner, Any individual with gold to pledge',
                           'PAN or Aadhaar, Gold Ornaments for Appraisal'),
  ('el_domestic',          'Educational Institution Applicant, Student with a co-applicant',
                           'PAN, Aadhaar, Admission Letter, Fee Structure, Co-applicant Income Proof, Bank Statement (6 Months)'),
  ('el_abroad',            'Student with a resident co-applicant',
                           'PAN, Aadhaar, Passport, Admission Letter, Fee Structure, Co-applicant Income Proof, Property Documents'),
  ('las_shares_mf',        'Salaried Employee, Retail Investor',
                           'PAN, Aadhaar, Demat/Portfolio Statement'),
  ('las_fd',               'Any Fixed Deposit Holder',
                           'PAN, Aadhaar, Fixed Deposit Receipt')
) as t(code, profile, docs)
where v.code = t.code;
