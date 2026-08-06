-- ===========================================================================
-- 0016 — Seed data for the Lending Product Catalogue
--
-- Hand-written, like 0009 and 0013, and for the same reason (ADR-025): this
-- is DATA. Every row below is a starting point maintained by people through
-- master_data.manage once the system is live, not a definition owned by code.
--
-- RESEARCH BASIS. The products named here are the ones Indian banks, housing
-- finance companies and NBFCs actually offer, using the terminology the
-- market and RBI use — cash credit and overdraft as separate working-capital
-- facilities, lease rental discounting as its own product, CGTMSE-backed
-- MSME lending, PMMY/Mudra, composite plot-plus-construction, balance
-- transfer and top-up as products rather than as processes. Nothing here is
-- invented and nothing here is bank-specific: "HDFC Smart Business Loan" is
-- a bank_product, and belongs to the Bank & NBFC Catalogue milestone.
--
-- ASSUMPTIONS, stated because the milestone brief asked for them:
--
--   1. Tenure and amount ranges are TYPICAL market ranges across the kind of
--      lenders Amaze deals with, rounded to round numbers. They are guidance
--      for an office user, never a rule (see loan_product.min_tenure_months'
--      comment). The binding figures are per lender, on bank_product.
--   2. Employment and business eligibility are drawn WIDE — the set of
--      profiles for which the product exists in the market at all, not the
--      set any one lender will approve. Narrowing is a lender's job, and
--      pretending otherwise is the mistake ADR-016 warns about.
--   3. GST requirement means "expected of the borrowing business", so it is
--      not_applicable wherever there is no business — a salaried personal
--      loan, a gold loan, an education loan.
--   4. Amounts are in rupees.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Loan categories — four more business lines beyond the four seeded in 0013.
-- These are Amaze's commercial groupings, and adding a fifth or ninth stays
-- an insert (ADR-030).
-- ---------------------------------------------------------------------------

insert into loan_category (code, name, description, display_order) values
  ('vehicle_loan',            'Vehicle Loan',            'Finance against a new or used vehicle, secured by hypothecation of the vehicle itself.', 50),
  ('gold_loan',               'Gold Loan',               'Short-tenure lending against pledged gold ornaments. Fast, small-ticket, no income proof in most cases.', 60),
  ('education_loan',          'Education Loan',          'Finance for higher education in India or overseas, usually with a moratorium during the course.', 70),
  ('loan_against_securities', 'Loan Against Securities', 'Overdraft or demand loan against pledged financial assets — shares, mutual funds, fixed deposits.', 80)
on conflict (code) do nothing;

update loan_category set description = 'Purchase, construction, improvement and refinance of residential property.'
  where code = 'home_loan' and description is null;
update loan_category set description = 'Working capital and term finance for a running business, funded and non-funded.'
  where code = 'business_loan' and description is null;
update loan_category set description = 'Lending against property already owned, for any declared end use.'
  where code = 'lap' and description is null;
update loan_category set description = 'Unsecured lending to an individual against income, for any personal end use.'
  where code = 'personal_loan' and description is null;

-- ---------------------------------------------------------------------------
-- Borrower types (Milestone 7)
-- ---------------------------------------------------------------------------

insert into borrower_type (code, name, description, display_order) values
  ('resident_individual', 'Resident Individual', 'A natural person resident in India. The default borrower for most retail products.', 10),
  ('nri_individual',      'NRI Individual',      'A non-resident Indian or person of Indian origin. Separate documentation, separate product variants, repayment from NRE/NRO accounts.', 20),
  ('non_individual',      'Non-Individual Entity', 'A firm, company, LLP, HUF or trust borrowing in its own name. Which constitutions qualify for a given product is recorded separately (business_constitution).', 30)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Security types (Milestone 7)
-- ---------------------------------------------------------------------------

insert into security_type (code, name, description, display_order) values
  ('unsecured',             'Unsecured (Clean)',                    'No security. Priced against income and credit history alone.', 10),
  ('immovable_property',    'Mortgage of Immovable Property',       'Equitable or registered mortgage of land or built property.', 20),
  ('gold_pledge',           'Pledge of Gold Ornaments',             'Physical gold held by the lender for the tenure of the loan.', 30),
  ('vehicle_hypothecation', 'Hypothecation of Vehicle',             'The financed vehicle itself, endorsed in the registration certificate.', 40),
  ('plant_machinery',       'Hypothecation of Plant and Machinery', 'The financed equipment, plant or machinery.', 50),
  ('stock_book_debts',      'Hypothecation of Stock and Book Debts','Current assets of a running business — inventory and receivables. The standard working-capital security.', 60),
  ('financial_securities',  'Pledge of Financial Securities',       'Shares, mutual fund units, bonds or deposits pledged with the lender.', 70),
  ('guarantee_backed',      'Guarantee Backed',                     'Secured by a guarantee rather than an asset — CGTMSE, CGFMU or a third-party personal guarantee.', 80)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Requirement applicability (Milestone 7) — shared by property and GST.
-- ---------------------------------------------------------------------------

insert into requirement_applicability (code, name, description, display_order) values
  ('mandatory',      'Mandatory',      'The product cannot proceed without it.', 10),
  ('optional',       'Optional',       'Accepted and sometimes asked for, but the product exists without it.', 20),
  ('not_applicable', 'Not Applicable', 'The product has no use for it. Nothing should ask.', 30)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- The lending products themselves.
--
-- `category` and `variant` (the free-text pair loan_product has carried since
-- 0003) are still written for every row, so anything still reading them sees
-- a complete table. `name` and `loan_category_id` are what new code reads.
-- ---------------------------------------------------------------------------

insert into loan_product (
  code, category, variant, name, description,
  loan_category_id, security_type_id, property_requirement_id, gst_requirement_id,
  min_tenure_months, max_tenure_months, min_amount, max_amount, display_order
)
select
  v.code, c.name, v.variant, v.name, v.description,
  c.id, s.id, pr.id, gr.id,
  v.min_tenure, v.max_tenure, v.min_amount, v.max_amount, v.display_order
from (values
  -- ── Home Loan ────────────────────────────────────────────────────────────
  ('hl_purchase', 'home_loan', 'Purchase', 'Home Loan — Purchase',
   'Purchase of a ready or under-construction residential property from a builder or a resale seller.',
   'immovable_property', 'mandatory', 'optional', 60, 360, 500000::numeric, 100000000::numeric, 10),

  ('hl_self_construct', 'home_loan', 'Self Construction', 'Home Construction Loan',
   'Construction of a house on a plot the borrower already owns. Disbursed in stages against construction progress.',
   'immovable_property', 'mandatory', 'optional', 60, 300, 500000::numeric, 50000000::numeric, 20),

  ('hl_plot_purchase', 'home_loan', 'Plot Purchase', 'Plot Purchase Loan',
   'Purchase of residential land, with no construction commitment. Shorter tenure and lower funding than a home loan.',
   'immovable_property', 'mandatory', 'optional', 36, 180, 500000::numeric, 30000000::numeric, 30),

  ('hl_plot_construction', 'home_loan', 'Plot and Construction', 'Composite Plot and Construction Loan',
   'One sanction covering the purchase of a plot and the construction on it, disbursed in two phases. Priced as a home loan rather than a plot loan because construction is committed.',
   'immovable_property', 'mandatory', 'optional', 60, 300, 500000::numeric, 50000000::numeric, 40),

  ('hl_improvement', 'home_loan', 'Improvement', 'Home Improvement Loan',
   'Renovation, repair or interior work on a property the borrower owns.',
   'immovable_property', 'mandatory', 'optional', 12, 180, 100000::numeric, 5000000::numeric, 50),

  ('hl_extension', 'home_loan', 'Extension', 'Home Extension Loan',
   'Adding built-up area to an existing house — a room, a floor. Needs approved plans, which renovation usually does not.',
   'immovable_property', 'mandatory', 'optional', 36, 240, 200000::numeric, 10000000::numeric, 60),

  ('hl_balance_transfer', 'home_loan', 'Balance Transfer', 'Home Loan Balance Transfer',
   'Takeover of an existing home loan from another lender, usually for a lower rate. Needs the existing lender''s foreclosure and repayment track record.',
   'immovable_property', 'mandatory', 'optional', 36, 360, 500000::numeric, 100000000::numeric, 70),

  ('hl_top_up', 'home_loan', 'Top-up', 'Home Loan Top-up',
   'Additional lending on an existing home loan, against the same mortgage. Usually taken alongside a balance transfer.',
   'immovable_property', 'mandatory', 'optional', 12, 240, 100000::numeric, 10000000::numeric, 80),

  ('hl_nri', 'home_loan', 'NRI', 'NRI Home Loan',
   'Home loan to a non-resident Indian. Same security, different documentation — passport and visa, overseas income proof, a resident power of attorney holder, repayment from NRE/NRO accounts.',
   'immovable_property', 'mandatory', 'not_applicable', 60, 300, 1000000::numeric, 100000000::numeric, 90),

  ('hl_affordable', 'home_loan', 'Affordable Housing', 'Affordable Housing Loan',
   'Small-ticket home loan for the informal-income and lower-income segment, the space affordable housing finance companies specialise in. Eligible for central subsidy schemes where the borrower qualifies.',
   'immovable_property', 'mandatory', 'optional', 60, 240, 200000::numeric, 5000000::numeric, 100),

  -- ── Business Loan ────────────────────────────────────────────────────────
  ('bl_working_capital', 'business_loan', 'Working Capital', 'Working Capital Facility (Cash Credit)',
   'A revolving limit against stock and receivables, drawn and repaid as the business cycle requires. Renewed annually against a stock statement and audited financials, not repaid in EMIs.',
   'stock_book_debts', 'optional', 'mandatory', 12, 12, 500000::numeric, 100000000::numeric, 110),

  ('bl_overdraft', 'business_loan', 'Overdraft', 'Business Overdraft',
   'A drawing limit on the current account, secured by property or deposits rather than by stock. Interest on the drawn balance only.',
   'immovable_property', 'optional', 'mandatory', 12, 12, 200000::numeric, 50000000::numeric, 120),

  ('bl_term_loan', 'business_loan', 'Term Loan', 'Business Term Loan',
   'A fixed-tenure loan repaid in EMIs, for a defined business purpose — expansion, a new premises, working-capital margin.',
   'immovable_property', 'optional', 'mandatory', 12, 120, 500000::numeric, 100000000::numeric, 130),

  ('bl_unsecured', 'business_loan', 'Unsecured', 'Unsecured Business Loan',
   'Clean business lending priced against banking turnover and GST returns. The fastest business product and the most expensive; the NBFC segment''s core offering.',
   'unsecured', 'not_applicable', 'mandatory', 12, 60, 100000::numeric, 7500000::numeric, 140),

  ('bl_machinery', 'business_loan', 'Machinery', 'Machinery and Equipment Loan',
   'Finance for plant, machinery or equipment, secured by the asset being financed. Common in Coimbatore''s engineering and textile units.',
   'plant_machinery', 'optional', 'mandatory', 12, 84, 300000::numeric, 50000000::numeric, 150),

  ('bl_msme_cgtmse', 'business_loan', 'MSME CGTMSE', 'MSME Term Loan (CGTMSE-backed)',
   'Term or composite finance to a registered MSME, collateral-free under the CGTMSE guarantee scheme. Needs Udyam registration; the guarantee replaces the security a lender would otherwise ask for.',
   'guarantee_backed', 'not_applicable', 'mandatory', 12, 84, 100000::numeric, 20000000::numeric, 160),

  ('bl_mudra', 'business_loan', 'Mudra', 'Mudra Loan (PMMY)',
   'Micro-enterprise finance under the Pradhan Mantri Mudra Yojana, in the Shishu, Kishore, Tarun and Tarun Plus tiers. Collateral-free, guarantee-covered, the smallest formal business product.',
   'guarantee_backed', 'not_applicable', 'optional', 12, 60, 10000::numeric, 2000000::numeric, 170),

  ('bl_bill_discounting', 'business_loan', 'Bill Discounting', 'Bill and Invoice Discounting',
   'Advance against accepted invoices or bills of exchange, repaid when the buyer pays. Tenure is the credit period, not a repayment schedule.',
   'stock_book_debts', 'not_applicable', 'mandatory', 1, 12, 500000::numeric, 50000000::numeric, 180),

  ('bl_non_fund_based', 'business_loan', 'Non-Fund Based', 'Bank Guarantee and Letter of Credit',
   'Non-fund-based limits — a bank guarantee to a buyer or department, or a letter of credit to a supplier. No money moves unless the instrument is invoked, but the limit is assessed like any other exposure.',
   'guarantee_backed', 'optional', 'mandatory', 1, 36, 100000::numeric, 50000000::numeric, 190),

  -- ── Loan Against Property ────────────────────────────────────────────────
  ('lap', 'lap', 'Loan Against Property', 'Loan Against Property — Residential',
   'Mortgage of a residential property the borrower already owns, for a declared end use. Amaze''s highest-volume secured product after home loans.',
   'immovable_property', 'mandatory', 'optional', 36, 240, 500000::numeric, 100000000::numeric, 200),

  ('lap_commercial', 'lap', 'Commercial Property', 'Loan Against Property — Commercial',
   'Mortgage of a shop, office, godown or industrial unit. Lower funding ratio and tighter valuation than residential LAP.',
   'immovable_property', 'mandatory', 'mandatory', 36, 180, 500000::numeric, 100000000::numeric, 210),

  ('lap_lrd', 'lap', 'Lease Rental Discounting', 'Lease Rental Discounting',
   'Lending against the rent receivable under a registered lease, repaid from the rent itself. Assessed on the tenant''s covenant and the residual lease term, not on the landlord''s income.',
   'immovable_property', 'mandatory', 'optional', 36, 180, 2000000::numeric, 200000000::numeric, 220),

  ('lap_balance_transfer', 'lap', 'Balance Transfer', 'LAP Balance Transfer and Top-up',
   'Takeover of an existing loan against property, usually with additional lending on the same security.',
   'immovable_property', 'mandatory', 'optional', 36, 240, 500000::numeric, 100000000::numeric, 230),

  -- ── Personal Loan ────────────────────────────────────────────────────────
  ('pl', 'personal_loan', 'Personal Loan', 'Personal Loan — Salaried',
   'Unsecured lending to a salaried individual against take-home income and employer category.',
   'unsecured', 'not_applicable', 'not_applicable', 12, 72, 50000::numeric, 4000000::numeric, 240),

  ('pl_self_employed', 'personal_loan', 'Self-Employed', 'Personal Loan — Self-Employed',
   'Unsecured personal lending assessed on ITR and banking rather than on payslips. Shorter tenure and smaller ticket than the salaried variant.',
   'unsecured', 'not_applicable', 'optional', 12, 60, 50000::numeric, 2500000::numeric, 250),

  ('pl_professional', 'personal_loan', 'Professional', 'Professional Loan',
   'Unsecured lending to a qualified professional — doctor, chartered accountant, architect, engineer — priced off the qualification and practice vintage rather than off collateral.',
   'unsecured', 'not_applicable', 'optional', 12, 84, 100000::numeric, 7500000::numeric, 260),

  -- ── Vehicle Loan ─────────────────────────────────────────────────────────
  ('vl_new_car', 'vehicle_loan', 'New Car', 'New Car Loan',
   'Finance for a new passenger vehicle, secured by hypothecation endorsed in the registration certificate.',
   'vehicle_hypothecation', 'not_applicable', 'not_applicable', 12, 84, 100000::numeric, 10000000::numeric, 270),

  ('vl_used_car', 'vehicle_loan', 'Used Car', 'Used Car Loan',
   'Finance for a pre-owned vehicle. Funding is against a valuation of the vehicle, and tenure is capped by the vehicle''s age.',
   'vehicle_hypothecation', 'not_applicable', 'not_applicable', 12, 60, 100000::numeric, 5000000::numeric, 280),

  ('vl_two_wheeler', 'vehicle_loan', 'Two-Wheeler', 'Two-Wheeler Loan',
   'Small-ticket finance for a motorcycle or scooter, usually sourced at the dealership.',
   'vehicle_hypothecation', 'not_applicable', 'not_applicable', 12, 48, 20000::numeric, 500000::numeric, 290),

  ('vl_commercial_vehicle', 'vehicle_loan', 'Commercial Vehicle', 'Commercial Vehicle Loan',
   'Finance for goods or passenger commercial vehicles, assessed on the transport business''s route and earnings rather than on salary.',
   'vehicle_hypothecation', 'not_applicable', 'optional', 12, 60, 200000::numeric, 20000000::numeric, 300),

  -- ── Gold Loan ────────────────────────────────────────────────────────────
  ('gl_gold', 'gold_loan', 'Gold Loan', 'Gold Loan',
   'Short-tenure lending against pledged gold ornaments, disbursed the same day. No income assessment in the ordinary case — the security is the whole underwriting.',
   'gold_pledge', 'not_applicable', 'not_applicable', 3, 36, 10000::numeric, 5000000::numeric, 310),

  -- ── Education Loan ───────────────────────────────────────────────────────
  ('el_domestic', 'education_loan', 'Domestic', 'Education Loan — Domestic',
   'Finance for higher education in India, with a moratorium covering the course and a grace period after it. Small tickets are collateral-free; larger ones need security.',
   'unsecured', 'optional', 'not_applicable', 12, 180, 50000::numeric, 5000000::numeric, 320),

  ('el_abroad', 'education_loan', 'Overseas', 'Education Loan — Overseas',
   'Finance for study abroad, covering tuition and living costs. Almost always needs collateral and a resident co-applicant.',
   'immovable_property', 'mandatory', 'not_applicable', 12, 180, 500000::numeric, 20000000::numeric, 330),

  -- ── Loan Against Securities ──────────────────────────────────────────────
  ('las_shares_mf', 'loan_against_securities', 'Shares and Mutual Funds', 'Loan Against Shares and Mutual Funds',
   'An overdraft against pledged listed shares or mutual fund units, with the limit revised as the market moves. Liquidity without selling the portfolio.',
   'financial_securities', 'not_applicable', 'not_applicable', 12, 36, 100000::numeric, 50000000::numeric, 340),

  ('las_fd', 'loan_against_securities', 'Fixed Deposit', 'Loan Against Fixed Deposit',
   'An overdraft against the borrower''s own term deposit, priced a small spread over the deposit rate. The cheapest borrowing available to a depositor.',
   'financial_securities', 'not_applicable', 'not_applicable', 3, 60, 10000::numeric, 50000000::numeric, 350)
) as v(
  code, category_code, variant, name, description,
  security_code, property_req, gst_req, min_tenure, max_tenure, min_amount, max_amount, display_order
)
join loan_category c on c.code = v.category_code
join security_type s on s.code = v.security_code
join requirement_applicability pr on pr.code = v.property_req
join requirement_applicability gr on gr.code = v.gst_req
on conflict (code) do update set
  category                = excluded.category,
  variant                 = excluded.variant,
  name                    = excluded.name,
  description             = excluded.description,
  loan_category_id        = excluded.loan_category_id,
  security_type_id        = excluded.security_type_id,
  property_requirement_id = excluded.property_requirement_id,
  gst_requirement_id      = excluded.gst_requirement_id,
  min_tenure_months       = excluded.min_tenure_months,
  max_tenure_months       = excluded.max_tenure_months,
  min_amount              = excluded.min_amount,
  max_amount              = excluded.max_amount,
  display_order           = excluded.display_order;

-- ---------------------------------------------------------------------------
-- Borrower eligibility.
--
-- NRI is listed only where the market genuinely offers the product to a
-- non-resident. Non-individual is listed wherever a firm can be the borrower
-- of record — which is most business and property products, and no retail
-- one.
-- ---------------------------------------------------------------------------

insert into loan_product_borrower_type (loan_product_id, borrower_type_id)
select p.id, b.id
from (values
  ('hl_purchase',          'resident_individual,nri_individual'),
  ('hl_self_construct',    'resident_individual,nri_individual'),
  ('hl_plot_purchase',     'resident_individual'),
  ('hl_plot_construction', 'resident_individual'),
  ('hl_improvement',       'resident_individual'),
  ('hl_extension',         'resident_individual'),
  ('hl_balance_transfer',  'resident_individual,nri_individual'),
  ('hl_top_up',            'resident_individual,nri_individual'),
  ('hl_nri',               'nri_individual'),
  ('hl_affordable',        'resident_individual'),
  ('bl_working_capital',   'resident_individual,non_individual'),
  ('bl_overdraft',         'resident_individual,non_individual'),
  ('bl_term_loan',         'resident_individual,non_individual'),
  ('bl_unsecured',         'resident_individual,non_individual'),
  ('bl_machinery',         'resident_individual,non_individual'),
  ('bl_msme_cgtmse',       'resident_individual,non_individual'),
  ('bl_mudra',             'resident_individual,non_individual'),
  ('bl_bill_discounting',  'resident_individual,non_individual'),
  ('bl_non_fund_based',    'resident_individual,non_individual'),
  ('lap',                  'resident_individual,nri_individual,non_individual'),
  ('lap_commercial',       'resident_individual,non_individual'),
  ('lap_lrd',              'resident_individual,non_individual'),
  ('lap_balance_transfer', 'resident_individual,non_individual'),
  ('pl',                   'resident_individual'),
  ('pl_self_employed',     'resident_individual'),
  ('pl_professional',      'resident_individual'),
  ('vl_new_car',           'resident_individual,non_individual'),
  ('vl_used_car',          'resident_individual'),
  ('vl_two_wheeler',       'resident_individual'),
  ('vl_commercial_vehicle','resident_individual,non_individual'),
  ('gl_gold',              'resident_individual'),
  ('el_domestic',          'resident_individual'),
  ('el_abroad',            'resident_individual'),
  ('las_shares_mf',        'resident_individual,non_individual'),
  ('las_fd',               'resident_individual,non_individual')
) as v(product_code, borrower_codes)
join loan_product p on p.code = v.product_code
join borrower_type b on b.code = any (string_to_array(v.borrower_codes, ','))
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Employment eligibility — reusing `employment_type` (0012), which is the
-- same vocabulary a person's employment record already carries. This is the
-- join a future Document Requirement Engine reads to decide between payslips
-- and ITR without branching on a product code in TypeScript.
-- ---------------------------------------------------------------------------

insert into loan_product_employment_type (loan_product_id, employment_type_id)
select p.id, e.id
from (values
  ('hl_purchase',          'salaried,self_employed,business_owner'),
  ('hl_self_construct',    'salaried,self_employed,business_owner'),
  ('hl_plot_purchase',     'salaried,self_employed,business_owner'),
  ('hl_plot_construction', 'salaried,self_employed,business_owner'),
  ('hl_improvement',       'salaried,self_employed,business_owner'),
  ('hl_extension',         'salaried,self_employed,business_owner'),
  ('hl_balance_transfer',  'salaried,self_employed,business_owner'),
  ('hl_top_up',            'salaried,self_employed,business_owner'),
  ('hl_nri',               'salaried,self_employed'),
  ('hl_affordable',        'salaried,self_employed,business_owner'),
  ('bl_working_capital',   'self_employed,business_owner'),
  ('bl_overdraft',         'self_employed,business_owner'),
  ('bl_term_loan',         'self_employed,business_owner'),
  ('bl_unsecured',         'self_employed,business_owner'),
  ('bl_machinery',         'self_employed,business_owner'),
  ('bl_msme_cgtmse',       'self_employed,business_owner'),
  ('bl_mudra',             'self_employed,business_owner'),
  ('bl_bill_discounting',  'self_employed,business_owner'),
  ('bl_non_fund_based',    'self_employed,business_owner'),
  ('lap',                  'salaried,self_employed,business_owner'),
  ('lap_commercial',       'self_employed,business_owner'),
  ('lap_lrd',              'salaried,self_employed,business_owner'),
  ('lap_balance_transfer', 'salaried,self_employed,business_owner'),
  ('pl',                   'salaried'),
  ('pl_self_employed',     'self_employed,business_owner'),
  ('pl_professional',      'self_employed'),
  ('vl_new_car',           'salaried,self_employed,business_owner'),
  ('vl_used_car',          'salaried,self_employed,business_owner'),
  ('vl_two_wheeler',       'salaried,self_employed,business_owner'),
  ('vl_commercial_vehicle','self_employed,business_owner'),
  ('gl_gold',              'salaried,self_employed,business_owner'),
  ('el_domestic',          'salaried,self_employed,business_owner'),
  ('el_abroad',            'salaried,self_employed,business_owner'),
  ('las_shares_mf',        'salaried,self_employed,business_owner'),
  ('las_fd',               'salaried,self_employed,business_owner')
) as v(product_code, employment_codes)
join loan_product p on p.code = v.product_code
join employment_type e on e.code = any (string_to_array(v.employment_codes, ','))
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Business eligibility — reusing `business_constitution` (0012).
--
-- Listed only for products a firm can actually take. A product with no rows
-- here is one no firm borrows: a salaried personal loan, a two-wheeler loan,
-- an education loan. That emptiness is the answer, not a missing seed.
-- ---------------------------------------------------------------------------

insert into loan_product_business_constitution (loan_product_id, business_constitution_id)
select p.id, bc.id
from (values
  ('bl_working_capital',   'proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society'),
  ('bl_overdraft',         'proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society'),
  ('bl_term_loan',         'proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society'),
  ('bl_unsecured',         'proprietorship,partnership,llp,private_limited'),
  ('bl_machinery',         'proprietorship,partnership,llp,private_limited,public_limited'),
  -- CGTMSE and PMMY cover micro and small enterprises; a public limited
  -- company is outside the schemes' intent in practice.
  ('bl_msme_cgtmse',       'proprietorship,partnership,llp,private_limited,huf'),
  ('bl_mudra',             'proprietorship,partnership,huf'),
  ('bl_bill_discounting',  'proprietorship,partnership,llp,private_limited,public_limited'),
  ('bl_non_fund_based',    'proprietorship,partnership,llp,private_limited,public_limited'),
  ('lap',                  'proprietorship,partnership,llp,private_limited,huf'),
  ('lap_commercial',       'proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society'),
  ('lap_lrd',              'proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society'),
  ('lap_balance_transfer', 'proprietorship,partnership,llp,private_limited,huf'),
  ('vl_new_car',           'proprietorship,partnership,llp,private_limited,public_limited'),
  ('vl_commercial_vehicle','proprietorship,partnership,llp,private_limited'),
  ('las_shares_mf',        'proprietorship,partnership,llp,private_limited'),
  ('las_fd',               'proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society')
) as v(product_code, constitution_codes)
join loan_product p on p.code = v.product_code
join business_constitution bc on bc.code = any (string_to_array(v.constitution_codes, ','))
on conflict do nothing;
