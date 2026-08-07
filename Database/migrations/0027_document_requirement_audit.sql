-- ===========================================================================
-- 0027 — Document Requirement Engine audit and cleanup
--
-- The DATA below is GENERATED from src/domain/requirements/document-catalogue.ts
-- and default-rules.ts, which stay authoritative — same discipline as 0022,
-- 0023 and 0026. Regenerate rather than edit by hand. The schema preamble that
-- follows is written by hand, as every migration's is.
--
-- WHAT THE AUDIT FOUND
--
--  1. THE CHECKLIST APPEARED TO ASK FOR THE SAME DOCUMENT TWICE. It was not:
--     a business loan asks for two years of GST returns, two of the ITR, two
--     of the balance sheet and two of the P&L, and each of those eight rows is
--     a distinct year with its own upload, its own verification and its own
--     storage path. But every pair rendered under one name — "GST Returns",
--     "GST Returns" — and a list that looks buggy is a list people stop
--     trusting, including the parts of it that are right.
--
--     The period now belongs to the row's NAME. document_type.period_kind
--     says how: by FINANCIAL year for returns, banking and accounts, by
--     ASSESSMENT year for the ITRs and Form 16 / 26AS. The window is the same
--     April-to-March year either way — this changes no dates and no logic —
--     but a customer knows their return by its assessment year, and asking
--     for "the FY 2024-25 ITR" gets the previous year's filing handed over.
--
--  2. ONE DOCUMENT WAS GENUINELY ASKED FOR TWICE, ON BUSINESS LOANS. A
--     proprietor was asked for the personal ITR (income_itr) and, from 0026,
--     the business ITR — which on a proprietorship is the same filing. The
--     business rule now names org_itr, income_itr stands down on business
--     loans, and a new rule asks the promoter for their personal return only
--     where a separate firm is actually borrowing.
--
--  3. THE GROUPING WAS A FILING TAXONOMY, NOT A COLLECTION ORDER. "Business"
--     against "Financial" put a GST certificate beside a stock statement and
--     separated the GST certificate from the GST returns. A telecaller
--     collects a business's PAPERS in one pass and its NUMBERS in another —
--     often from two different people at the customer's end. The categories
--     are now Business Registration and Business Financials.
--
--  4. AMAZE'S BUSINESS-LOAN SET WAS INCOMPLETE. The business PAN was asked
--     for only when a separate firm was a party, so the ordinary
--     proprietorship file never saw it.
--
-- Plus document_type.examples, for the documents where the honest answer is a
-- list and not a sentence — address proof above all, which is the single
-- most-asked question on a collection call.
--
-- Every row here remains a DEFAULT, editable by a business user afterwards.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Schema.
-- ---------------------------------------------------------------------------

create type app.document_period_kind as enum ('financial_year', 'assessment_year');

comment on type app.document_period_kind is
  'How a recurring document names its period TO THE CUSTOMER. The window is '
  'identical — India''s April-to-March year — but an ITR is known by its '
  'assessment year, one ahead of the financial year it reports. Presentation '
  'only: nothing in the engine, the storage path or the period columns '
  'branches on this.';

alter table document_type
  add column period_kind app.document_period_kind,
  add column examples    text[];

comment on column document_type.examples is
  'What actually counts, where the honest answer is a list rather than a '
  'sentence: address proof is an EB bill OR a gas bill OR a ration card OR a '
  'passport OR a driving licence. Rendered as bullets under the row, because '
  '"what can I give for address proof?" is asked on nearly every call.';

-- ---------------------------------------------------------------------------
-- Collection sections, renamed.
--
-- 'business' and 'financial' become 'business_registration' and
-- 'business_financials'. The type is REPLACED rather than extended with
-- `alter type ... add value`, for two reasons: a value added that way cannot
-- be used until the transaction commits, and this migration inserts rows
-- using the new values in the same transaction; and the two old values have
-- no rows worth preserving under their old names, so leaving them defined and
-- unused would be litter in a type a business user reads in a dropdown.
--
-- The column is parked as text across the swap, which is the only way to
-- rewrite an enum a column already depends on.
-- ---------------------------------------------------------------------------

-- Both columns that reference the type have to be parked before it can be
-- dropped: document_requirement.custom_category (0026) uses it too.
alter table document_type
  alter column category drop default,
  alter column category type text;

alter table document_requirement
  alter column custom_category type text;

drop type app.document_category;

create type app.document_category as enum (
  'kyc',
  'business_registration',
  'business_financials',
  'income',
  'property',
  'additional'
);

comment on type app.document_category is
  'The six sections of a collection call, in the order a call runs. These are '
  'COLLECTION sections, not a filing taxonomy: a telecaller collects a '
  'business''s PAPERS in one pass (registration, GST, Udyam, constitution) and '
  'its NUMBERS in another (returns, accounts, banking), because those are two '
  'different calls and often two different people at the customer''s end.';

update document_type
set category = case category
                 when 'business'  then 'business_registration'
                 when 'financial' then 'business_financials'
                 else category
               end;

alter table document_type
  alter column category type app.document_category using category::app.document_category,
  alter column category set default 'additional',
  alter column category set not null;

update document_requirement
set custom_category = case custom_category
                        when 'business'  then 'business_registration'
                        when 'financial' then 'business_financials'
                        else custom_category
                      end
where custom_category is not null;

alter table document_requirement
  alter column custom_category type app.document_category
  using custom_category::app.document_category;


-- ---------------------------------------------------------------------------
-- Every document type: name, local name, description, examples, category and
-- period kind, exactly as the catalogue defines them.
--
-- ONE CANONICAL DEFINITION PER CODE. document_type.code is unique, this
-- statement is keyed on it, and the domain test
-- `has exactly one canonical definition for every document code` holds the
-- other end shut.
-- ---------------------------------------------------------------------------

insert into document_type (code, name, local_name, owner_kind, requires_period, requires_expiry, description, examples, category, period_kind, display_order) values
  ('pan_card', 'PAN Card', null, 'person', false, false, 'The customer''s own PAN card. Every lender asks for it and none of them waive it.', null, 'kyc', null, 10),
  ('aadhaar_card', 'Aadhaar Card', null, 'person', false, false, 'Front and back. Serves as both identity and address proof for most lenders.', null, 'kyc', null, 20),
  ('address_proof', 'Address Proof', null, 'person', false, true, 'Any one of these, in the customer''s name and not more than three months old.', array['EB Bill', 'Gas Bill', 'Ration Card', 'Passport', 'Driving Licence', 'Rental Agreement'], 'kyc', null, 30),
  ('photograph', 'Passport Size Photograph', null, 'person', false, false, 'One recent passport size photo. A clear phone photo of the print is enough to start.', null, 'kyc', null, 40),
  ('salary_slip', 'Salary Slip', 'Payslip', 'person', true, false, 'Last three months'' payslips. Six months where the salary includes incentive or overtime.', null, 'income', null, 50),
  ('form_16', 'Form 16', null, 'person', true, false, 'The employer''s annual salary and TDS certificate, one per year.', null, 'income', 'assessment_year', 60),
  ('bank_statement', 'Bank Statement', null, 'person', true, false, 'Statement of the account the salary or income comes into. Six months for salaried, twelve for self-employed. A PDF downloaded from net banking is accepted.', null, 'income', 'financial_year', 70),
  ('itr', 'ITR', 'Income Tax Return', 'person', true, false, 'The customer''s personal income tax return with the computation sheet, one per assessment year.', null, 'income', 'assessment_year', 80),
  ('gst_certificate', 'GST Registration Certificate (GST REG-06)', null, 'organisation', false, false, 'The certificate issued after GST registration. It carries the GSTIN.', null, 'business_registration', null, 90),
  ('gst_returns', 'GST 3B', 'GSTR-3B', 'organisation', true, false, 'Monthly GST return. Ask for a full financial year at a time — lenders read the last twelve months to see real turnover.', null, 'business_financials', 'financial_year', 110),
  ('balance_sheet', 'Balance Sheet', null, 'organisation', true, false, 'The year-end statement of what the business owns and owes, signed by the auditor or CA.', null, 'business_financials', 'financial_year', 120),
  ('profit_and_loss', 'Profit & Loss Statement', 'P&L Account', 'organisation', true, false, 'The year''s income and expenses, signed by the auditor or CA. Filed with the balance sheet.', null, 'business_financials', 'financial_year', 130),
  ('sale_deed', 'Sale Deed', 'Title Deed', 'property', false, false, 'The registered deed by which the current owner bought the property.', null, 'property', null, 140),
  ('encumbrance_cert', 'Encumbrance Certificate (EC)', 'Villangam', 'property', true, false, 'The Sub-Registrar''s record of every sale and loan registered on the property. Banks ask for the last thirteen years.', null, 'property', null, 150),
  ('approved_plan', 'Building Approval Plan', 'Plan Approval', 'property', false, false, 'The building plan sanctioned by the panchayat, municipality, CMDA or DTCP.', null, 'property', null, 160),
  ('valuation_report', 'Property Valuation Report', null, 'property', false, true, 'The bank''s own valuer visits and values the property. Arranged after the bank is chosen.', null, 'property', null, 170),
  ('login_form', 'Bank Login Form', null, 'case', false, false, 'The bank''s own application form, signed. Only available once a bank has been chosen.', null, 'additional', null, 180),
  ('sanction_letter', 'Sanction Letter', null, 'case', false, true, 'The bank''s letter confirming the approved amount and terms.', null, 'additional', null, 190),
  ('signature_proof', 'Signature Proof', null, 'person', false, false, 'A specimen signature on a blank sheet, asked for when the signature on the PAN is unclear.', null, 'kyc', null, 200),
  ('credit_bureau_consent', 'Loan Consent Form', 'CIBIL Consent', 'person', false, false, 'The customer''s signed permission to check their CIBIL score. We cannot check it without this.', null, 'kyc', null, 210),
  ('passport', 'Passport', null, 'person', false, true, 'Photo page and address page. Needed for NRI customers and for study-abroad loans.', null, 'kyc', null, 220),
  ('visa', 'Visa / Work Permit', null, 'person', false, true, 'The current visa or work permit page, for a customer living or studying abroad.', null, 'kyc', null, 230),
  ('power_of_attorney', 'Power of Attorney (POA)', null, 'person', false, false, 'A registered POA given to a relative in India, so papers can be signed here while the customer is abroad.', null, 'kyc', null, 240),
  ('employment_certificate', 'Employment Certificate', 'Job Certificate', 'person', false, false, 'A letter from the employer confirming the designation, how long they have worked there, and the salary.', null, 'income', null, 250),
  ('appointment_letter', 'Appointment Letter', 'Offer Letter', 'person', false, false, 'The joining letter from the employer. Asked for when the customer has joined recently.', null, 'income', null, 260),
  ('qualification_proof', 'Qualification Certificate', 'Degree Certificate', 'person', false, false, 'The degree or professional certificate — doctor, CA, engineer. A professional loan is given on the strength of it.', null, 'income', null, 270),
  ('professional_practice_proof', 'Practice Proof', null, 'person', false, false, 'Proof of how long they have practised.', array['Council Registration', 'Clinic Licence', 'Professional Body Membership'], 'income', null, 280),
  ('overseas_income_proof', 'Overseas Income Proof', null, 'person', true, false, 'Foreign payslips or the employment contract for an NRI customer. Usually needs attestation.', null, 'income', null, 290),
  ('net_worth_statement', 'Net Worth Statement', null, 'person', false, false, 'A CA''s list of what the guarantor owns and owes. A guarantee is worth what the guarantor is worth.', null, 'income', null, 300),
  ('existing_loan_statement', 'Existing Loan Statement', 'Loan Account Statement', 'person', true, false, 'Statement of any loan the customer is already repaying, showing the EMI and how regularly it is paid.', null, 'income', null, 310),
  ('foreclosure_letter', 'Foreclosure Letter', 'Closure Quote', 'person', false, true, 'The existing bank''s letter stating the exact amount needed to close the loan. It expires quickly, so ask for it late.', null, 'income', null, 320),
  ('org_pan', 'Business PAN Card', null, 'organisation', false, false, 'The firm''s own PAN card. A proprietorship uses the owner''s personal PAN instead.', null, 'business_registration', null, 330),
  ('org_address_proof', 'Business Address Proof', null, 'organisation', false, false, 'In the business''s name, not more than three months old.', array['EB Bill', 'Rental Agreement', 'Lease Deed', 'Property Tax Receipt'], 'business_registration', null, 340),
  ('business_proof', 'Business Registration Proof', 'Business Proof', 'organisation', false, false, 'Anything that shows the business is real and running.', array['Shop & Establishment Licence', 'Trade Licence', 'Registration Deed'], 'business_registration', null, 350),
  ('udyam_certificate', 'Udyam Registration Certificate', 'Udyog Aadhaar / MSME Certificate', 'organisation', false, false, 'The MSME registration certificate. Compulsory for MUDRA and CGTMSE loans, and asked for on every other business loan.', null, 'business_registration', null, 360),
  ('org_itr', 'Business ITR', null, 'organisation', true, false, 'The business''s income tax return with computation, one per assessment year. On a proprietorship this is the owner''s own return.', null, 'business_financials', 'assessment_year', 370),
  ('org_bank_statement', 'Business Bank Statement', 'Current Account Statement', 'organisation', true, false, 'Twelve months of the business account. This is what the bank reads to judge daily turnover.', null, 'business_financials', 'financial_year', 380),
  ('audit_report', 'Audit Report', null, 'organisation', true, false, 'The auditor''s report for the year. Companies and LLPs have one; a small proprietorship usually does not.', null, 'business_financials', 'financial_year', 390),
  ('stock_statement', 'Stock Statement', null, 'organisation', true, false, 'A list of stock in hand and money customers owe. This is the security on a cash credit limit.', null, 'business_financials', 'financial_year', 400),
  ('debtors_creditors_statement', 'Debtors & Creditors List', null, 'organisation', true, false, 'Who owes the business money and whom it owes, with how long each has been outstanding.', null, 'business_financials', 'financial_year', 410),
  ('project_report', 'Project Report', null, 'organisation', false, false, 'A written plan of what the loan will be spent on, with costs. Usually prepared by a CA.', null, 'additional', null, 420),
  ('machinery_quotation', 'Machinery Quotation', null, 'organisation', false, false, 'The supplier''s price quotation for the machine being bought.', null, 'additional', null, 430),
  ('contract_or_tender', 'Contract / Work Order', 'Tender Document', 'organisation', false, false, 'The order or contract the bank guarantee or letter of credit is being taken for.', null, 'additional', null, 440),
  ('invoice_bills', 'Invoices / Bills', null, 'organisation', false, false, 'The bills being discounted.', null, 'additional', null, 450),
  ('buyer_acceptance', 'Buyer Acceptance Letter', null, 'organisation', false, false, 'The buyer''s written confirmation that they accept the invoice and will pay it.', null, 'additional', null, 460),
  ('partnership_deed', 'Partnership Deed', null, 'organisation', false, false, 'The registered deed naming the current partners and their shares.', null, 'business_registration', null, 470),
  ('llp_agreement', 'LLP Agreement', null, 'organisation', false, false, 'The LLP''s agreement as filed with the Registrar.', null, 'business_registration', null, 480),
  ('certificate_of_incorporation', 'Certificate of Incorporation', 'Company Registration Certificate', 'organisation', false, false, 'The Registrar of Companies certificate issued when the company was formed.', null, 'business_registration', null, 490),
  ('moa_aoa', 'MOA & AOA', null, 'organisation', false, false, 'The company''s Memorandum and Articles of Association. These say whether the company is allowed to borrow.', null, 'business_registration', null, 500),
  ('board_resolution', 'Board Resolution', null, 'organisation', false, false, 'The board''s written decision to take this loan and who may sign for it.', null, 'business_registration', null, 510),
  ('list_of_directors', 'List of Directors / Partners', null, 'organisation', false, false, 'The current directors or partners with their DIN, as filed.', null, 'business_registration', null, 520),
  ('shareholding_pattern', 'Shareholding Pattern', null, 'organisation', false, false, 'Who owns the company and what percentage each holds.', null, 'business_registration', null, 530),
  ('trust_deed', 'Trust Deed', null, 'organisation', false, false, 'The deed that created the trust and states its borrowing powers.', null, 'business_registration', null, 540),
  ('society_registration', 'Society Registration Certificate', null, 'organisation', false, false, 'The society''s registration certificate from the Registrar of Societies.', null, 'business_registration', null, 550),
  ('sale_agreement', 'Sale Agreement', 'Agreement to Sell', 'property', false, false, 'The written agreement with the seller, before registration. It fixes the price the loan is calculated on.', null, 'property', null, 560),
  ('parent_document', 'Parent Documents', 'Previous Sale Deeds', 'property', false, false, 'The older sale deeds showing who owned the property before. Banks ask for thirteen to thirty years of them.', null, 'property', null, 570),
  ('patta_chitta', 'Patta & Chitta', null, 'property', false, false, 'The Tamil Nadu land ownership record. Patta shows who owns the land and Chitta shows what kind of land it is — issued together as one extract from the e-Services portal.', null, 'property', null, 580),
  ('property_tax_receipt', 'Property Tax Receipt', 'House Tax Receipt', 'property', true, false, 'The latest paid tax receipt from the panchayat or corporation.', null, 'property', null, 590),
  ('layout_approval', 'Layout Approval', 'DTCP / CMDA Approval', 'property', false, false, 'The approved layout for a plot, from DTCP, CMDA or the local body. An unapproved layout is the commonest reason a plot loan is refused.', null, 'property', null, 600),
  ('construction_estimate', 'Construction Estimate', 'Engineer''s Estimate', 'property', false, false, 'The engineer''s or architect''s costing of the building work. The bank releases money in stages against it.', null, 'property', null, 610),
  ('construction_progress_report', 'Construction Progress Report', 'Stage Certificate', 'property', true, false, 'The engineer''s certificate of how much of the building is finished. Each further release needs a fresh one.', null, 'property', null, 620),
  ('legal_opinion', 'Legal Opinion', null, 'property', false, false, 'The bank''s own lawyer checks the title and gives an opinion. Arranged after the bank is chosen.', null, 'property', null, 630),
  ('occupancy_certificate', 'Occupancy Certificate', 'OC / Completion Certificate', 'property', false, false, 'The local body''s certificate that the finished building may be lived in.', null, 'property', null, 640),
  ('builder_noc', 'Builder NOC / Allotment Letter', null, 'property', false, false, 'The builder''s no-objection letter and allotment letter, when buying from a builder.', null, 'property', null, 650),
  ('lease_deed', 'Registered Lease Deed', null, 'property', false, false, 'The registered lease for the property whose rent is being lent against.', null, 'property', null, 660),
  ('vehicle_quotation', 'Vehicle Quotation', 'Proforma Invoice', 'case', false, false, 'The dealer''s price quotation for the vehicle being bought.', null, 'additional', null, 670),
  ('vehicle_rc', 'Vehicle RC Book', null, 'case', false, false, 'The RC of a second-hand vehicle. The bank''s name is added to it after the loan is given.', null, 'additional', null, 680),
  ('vehicle_valuation', 'Vehicle Valuation Report', null, 'case', false, false, 'A valuer''s report on a second-hand vehicle. The vehicle''s age limits how long the loan can run.', null, 'additional', null, 690),
  ('vehicle_insurance', 'Vehicle Insurance', null, 'case', false, true, 'Full (comprehensive) insurance with the bank''s name added on it.', null, 'additional', null, 700),
  ('route_permit', 'Route Permit', null, 'case', false, true, 'The permit for a goods or passenger commercial vehicle.', null, 'additional', null, 710),
  ('gold_appraisal_note', 'Gold Appraisal Note', 'Appraiser''s Slip', 'case', false, false, 'The appraiser''s note of the weight, purity and value of the ornaments. On a gold loan this is the whole file.', null, 'additional', null, 720),
  ('admission_letter', 'Admission Letter', null, 'person', false, false, 'The college''s confirmed admission offer.', null, 'additional', null, 730),
  ('fee_structure', 'Fee Structure', null, 'person', false, false, 'The college''s fee schedule for the course. It decides how much can be sanctioned.', null, 'additional', null, 740),
  ('academic_records', 'Academic Records', 'Marksheets', 'person', false, false, 'Marksheets and entrance exam results.', null, 'additional', null, 750),
  ('demat_statement', 'Demat / Portfolio Statement', null, 'person', true, false, 'Statement of the shares or mutual funds being pledged, with today''s value.', null, 'additional', null, 760),
  ('fd_receipt', 'Fixed Deposit Receipt', 'FD Receipt', 'person', false, false, 'The deposit receipt being pledged for the loan.', null, 'additional', null, 770),
  ('application_form', 'Loan Application Form', null, 'case', false, false, 'Amaze''s own application form, filled and signed by the customer. Separate from the bank''s login form.', null, 'additional', null, 780),
  ('nach_mandate', 'NACH Mandate / Security Cheques', 'ECS Mandate', 'case', false, false, 'The signed EMI auto-debit mandate and any blank cheques the bank asks for.', null, 'additional', null, 790),
  ('tenant_kyc', 'Tenant KYC', null, 'case', false, false, 'Identity and agreement papers of the tenant paying the rent, for a rent-based loan.', null, 'additional', null, 800),
  ('form_26as', 'Form 26AS / AIS', 'Tax Credit Statement', 'person', true, false, 'The income tax department''s own record of income and TDS, downloaded from the income tax portal. Banks compare it against the ITR.', null, 'income', 'assessment_year', 810),
  ('own_contribution_proof', 'Own Contribution Proof', 'Margin Money Proof', 'case', false, false, 'Proof the customer has paid their own share — the builder''s or seller''s receipt, or the bank transfer that paid it.', null, 'additional', null, 820),
  ('other_document', 'Other Document', null, 'case', false, false, 'A document asked for on this case only, added by hand because the standard list did not cover it.', null, 'additional', null, 900)
on conflict (code) do update set
  name          = excluded.name,
  local_name    = excluded.local_name,
  description   = excluded.description,
  examples      = excluded.examples,
  category      = excluded.category,
  period_kind   = excluded.period_kind,
  display_order = excluded.display_order;


-- ---------------------------------------------------------------------------
-- Two rules. The business PAN, which Amaze asks for on every business loan
-- and which was previously reachable only through a separate firm; and the
-- promoter's personal ITR, which is a different filing from the firm's only
-- when a firm is actually borrowing.
-- ---------------------------------------------------------------------------

insert into document_requirement_rule (
  code, name, document_type_id, scope, party_roles, party_kind, property_roles,
  applicability_id, applicable_from_stage, financial_years, condition_match,
  display_order, notes
)
select
  v.code,
  v.name,
  dt.id,
  v.scope::app.rule_scope,
  case when v.party_roles = '' then null
       else string_to_array(v.party_roles, ',')::app.case_party_role[] end,
  nullif(v.party_kind, ''),
  case when v.property_roles = '' then null
       else string_to_array(v.property_roles, ',')::app.case_property_role[] end,
  ra.id,
  v.stage::app.progression_stage,
  nullif(v.financial_years, '')::smallint,
  v.condition_match,
  v.display_order::integer,
  nullif(v.notes, '')
from (values
  ('business_pan_by_product', 'Business PAN card — business loan', 'org_pan', 'party', 'applicant', 'person', '', 'mandatory', 'documents_pending', '', 'all', '748', 'Amaze asks for the business PAN on every business loan. A proprietorship does not have one and gives the owner''s personal PAN instead — the telecaller asks the same question either way, and the answer tells them which of the two it is.'),
  ('income_itr_business_promoter', 'ITR — promoter of the borrowing firm', 'itr', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '2', 'all', '317', 'Only where a separate firm is borrowing. Then the firm''s return and the promoter''s are two different filings and lenders read both; on a proprietorship they are one filing, and the business rule asks for it.')
) as v(code, name, document_type_code, scope, party_roles, party_kind,
       property_roles, applicability, stage, financial_years, condition_match,
       display_order, notes)
join document_type dt on dt.code = v.document_type_code
join requirement_applicability ra on ra.code = v.applicability
on conflict (code) do nothing;


-- ---------------------------------------------------------------------------
-- The business-loan ITR rule now names the BUSINESS return. On a
-- proprietorship the business return and the owner's return are one filing,
-- and naming both put the same document on the checklist twice.
-- ---------------------------------------------------------------------------

update document_requirement_rule r
set document_type_id = dt.id
from document_type dt
where r.code = 'business_itr_by_product' and dt.code = 'org_itr';


-- ---------------------------------------------------------------------------
-- Conditions, for the new rules and for income_itr, which now stands down on
-- a business loan. Cleared first so the migration is idempotent, and named
-- explicitly so a rule a business user has since edited is never touched.
-- ---------------------------------------------------------------------------

delete from document_requirement_rule_condition
where rule_id in (
  select id from document_requirement_rule
  where code in ('income_itr')
);

insert into document_requirement_rule_condition (rule_id, fact, operator, values, display_order)
select
  r.id,
  v.fact,
  v.operator::app.rule_condition_operator,
  case when v.vals = '' then null else string_to_array(v.vals, '|') end,
  v.display_order::integer
from (values
  ('business_pan_by_product', 'case.customer_product_code', 'in', 'business_loan', '10'),
  ('business_pan_by_product', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('income_itr_business_promoter', 'case.customer_product_code', 'in', 'business_loan', '10'),
  ('income_itr_business_promoter', 'case.has_borrower_firm', 'is_true', '', '20'),
  ('income_itr', 'party.employment_type', 'in', 'self_employed|business_owner', '10'),
  ('income_itr', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities|business_loan', '20')
) as v(rule_code, fact, operator, vals, display_order)
join document_requirement_rule r on r.code = v.rule_code
on conflict do nothing;


-- ---------------------------------------------------------------------------
-- Names, trailing years and notes for every rule the audit reworded.
-- ---------------------------------------------------------------------------

update document_requirement_rule r
set name            = v.name,
    financial_years = nullif(v.financial_years, '')::smallint,
    notes           = nullif(v.notes, '')
from (values
  ('kyc_pan', 'PAN card — everyone signing', '', 'Universal. The one identity document no lender waives above small-ticket gold.'),
  ('kyc_aadhaar', 'Aadhaar card — everyone signing', '', 'Serves as identity and address proof; used for e-KYC by most lenders.'),
  ('kyc_address_proof', 'Address proof — everyone signing', '', ''),
  ('kyc_photograph', 'Passport size photograph — everyone signing', '', ''),
  ('kyc_signature_proof', 'Signature proof', '', 'Asked for by some lenders where the PAN signature is unclear.'),
  ('kyc_credit_bureau_consent', 'Loan consent form (CIBIL check)', '', 'A bureau pull without written consent is not a shortcut, it is a breach. Excluded on gold, which is underwritten on the ornaments and is routinely sanctioned at the counter without a bureau pull at all.'),
  ('nri_passport', 'Passport — customer living abroad', '', ''),
  ('nri_visa', 'Visa or work permit — customer living abroad', '', ''),
  ('nri_overseas_income', 'Overseas income proof — customer living abroad', '', 'Overseas payslips or an employment contract, usually attested.'),
  ('nri_power_of_attorney', 'Power of attorney — customer living abroad', '', 'A resident POA holder is how the lender gets documents executed in India.'),
  ('income_salary_slip', 'Salary slips — salaried customer', '', 'Last three months is the market norm; six for variable-pay profiles.'),
  ('income_form_16', 'Form 16 — salaried customer', '2', ''),
  ('income_salaried_banking', 'Bank statement — the account salary comes into', '1', 'Six months of the salary-credit account.'),
  ('income_employment_certificate', 'Employment certificate', '', ''),
  ('income_appointment_letter', 'Appointment letter', '', 'Asked for where employment vintage is short.'),
  ('income_itr', 'ITR — self-employed customer', '2', 'Two assessment years with computation; the market standard.'),
  ('income_self_employed_banking', 'Bank statement — self-employed customer', '1', 'Twelve months, since there is no salary credit to read instead.'),
  ('income_form_26as', 'Form 26AS / AIS — self-employed customer', '2', 'Cross-checked against the ITR. A mismatch is the commonest reason a file stalls.'),
  ('income_form_26as_salaried', 'Form 26AS / AIS — salaried customer', '1', 'Supporting, not primary — Form 16 already carries the employer''s TDS.'),
  ('income_balance_sheet_individual', 'Balance sheet — business run in the customer''s own name', '2', 'CA-certified, two years. Where the firm IS on the file, the firm''s own rule covers this.'),
  ('income_profit_and_loss_individual', 'Profit & loss statement — business run in the customer''s own name', '2', ''),
  ('income_qualification_proof', 'Qualification certificate — professional', '', 'A professional loan is priced off the qualification; without it there is no product.'),
  ('income_practice_proof', 'Practice proof', '', 'Practice vintage — registration, clinic licence, professional body membership.'),
  ('income_practice_proof_professional', 'Practice proof — professional loan', '', 'Mandatory here, unlike the general optional rule above: a professional loan is priced off qualification AND vintage, so practice proof is the product, not a supporting document. The engine merges the two to the stricter reading.'),
  ('income_business_proof_individual', 'Business proof — business run in the customer''s own name', '', 'A proprietor borrowing in their own name still has to evidence the business. Where the firm IS on the file, the firm''s own rules cover this instead.'),
  ('guarantor_itr', 'ITR — guarantor', '1', ''),
  ('guarantor_net_worth', 'Net worth statement — guarantor', '', 'A guarantee is worth what the guarantor is worth.'),
  ('obligations_loan_statement', 'Existing loan statement', '', 'Repayment track on every live facility — the obligations half of FOIR. Gold and securities are not FOIR-assessed, so they do not ask.'),
  ('takeover_loan_statement', 'Existing loan statement — loan being transferred', '', 'A balance transfer is entirely about the loan being transferred.'),
  ('takeover_foreclosure_letter', 'Foreclosure letter — loan being transferred', '', 'Dated and short-lived; asking for it on day two wastes it.'),
  ('firm_pan', 'Business PAN card', '', ''),
  ('firm_address_proof', 'Business address proof', '', 'Utility bill or lease, dated within three months.'),
  ('firm_business_proof', 'Business proof', '', 'Shop & Establishment, trade licence, or the constitution document itself.'),
  ('firm_bank_statement', 'Business bank statement (current account)', '1', 'Twelve months of the current account — the working-capital assessment.'),
  ('firm_itr', 'Business ITR', '2', ''),
  ('firm_balance_sheet', 'Balance sheet', '2', ''),
  ('firm_profit_and_loss', 'Profit & loss statement', '2', ''),
  ('firm_audit_report', 'Audit report — companies and LLPs', '2', 'A proprietorship below the audit threshold has none, and is not asked.'),
  ('gst_certificate_firm', 'GST registration certificate (GST REG-06)', '', ''),
  ('gst_returns_firm', 'GST returns (GSTR-3B)', '2', 'GSTR-3B and GSTR-1 for the last financial year — the turnover the NBFC prices off.'),
  ('gst_certificate_individual', 'GST registration certificate (GST REG-06) — business in the customer''s own name', '', 'A GST-registered proprietor borrowing in their own name.'),
  ('gst_returns_individual', 'GST returns (GSTR-3B) — business in the customer''s own name', '2', 'The audit found the certificate rule above had no returns counterpart, so a registered proprietor was asked to prove registration and never asked for the turnover the registration produces.'),
  ('gst_certificate_firm_by_product', 'GST registration certificate (GST REG-06) — loan needs GST', '', 'Asked because the product cannot be assessed without GST, not because anyone ticked a box.'),
  ('gst_returns_firm_by_product', 'GST returns (GSTR-3B) — loan needs GST', '2', 'GSTR-3B and GSTR-1 for the last financial year — the turnover the NBFC prices off.'),
  ('gst_certificate_individual_by_product', 'GST registration certificate (GST REG-06) — loan needs GST, business in the customer''s own name', '', 'The proprietor case: the business is the person, and the product still needs GST. The Telecaller Workflow milestone dropped the employment-type condition that used to sit here — it starts undefined, so the rule fired on nothing at the one moment the telecaller needed it, and a product that declares GST mandatory has already said everything the employment type would have said.'),
  ('gst_returns_individual_by_product', 'GST returns (GSTR-3B) — loan needs GST, business in the customer''s own name', '2', ''),
  ('business_proof_by_product', 'Business registration proof — business loan', '', 'Shop & Establishment licence, trade licence or the registration deed. Asked because the loan is a business loan, not because anyone has yet said what kind of business it is.'),
  ('business_address_proof_by_product', 'Business address proof — business loan', '', 'EB bill or rental agreement for the shop or office, dated within three months.'),
  ('business_banking_by_product', 'Business bank statement (current account) — business loan', '1', 'Twelve months of the business account. On a proprietorship this is often the same account as the personal one, and the telecaller should ask for whichever the takings go into.'),
  ('business_itr_by_product', 'Business ITR — business loan', '2', 'Two assessment years with computation. The business ITR rather than the personal one, which is what Amaze asks for and what the lender reads — on a proprietorship they are the same filing, and `income_itr` stands down on a business loan so the checklist does not name one document twice.'),
  ('business_balance_sheet_by_product', 'Balance sheet — business loan', '2', ''),
  ('business_profit_and_loss_by_product', 'Profit & loss statement — business loan', '2', ''),
  ('constitution_partnership_deed', 'Partnership deed', '', ''),
  ('constitution_llp_agreement', 'LLP agreement', '', ''),
  ('constitution_incorporation', 'Certificate of incorporation', '', ''),
  ('constitution_moa_aoa', 'MOA & AOA', '', ''),
  ('constitution_board_resolution', 'Board resolution to take the loan', '', 'A company borrows by resolution. Without it nobody on the file has authority. The audit added LLP: designated partners resolve to borrow exactly as a board does, and the first pack asked an LLP for its agreement but never for the authority to sign. A partnership is deliberately absent — its deed names the authorised partners itself.'),
  ('constitution_director_list', 'List of directors or partners', '', ''),
  ('constitution_shareholding', 'Shareholding pattern', '', ''),
  ('constitution_trust_deed', 'Trust deed', '', ''),
  ('constitution_society_registration', 'Society registration certificate', '', ''),
  ('business_udyam_scheme', 'Udyam registration (MSME) — MUDRA and CGTMSE', '', 'CGTMSE and PMMY are only available to a registered MSME. No Udyam, no scheme.'),
  ('business_udyam_general', 'Udyam registration (MSME) — other business loans', '', 'Amaze asks for this on every business loan, so it is on the list from the start — but OPTIONAL, because a genuine small proprietor often has not registered, and a mandatory row would hold up a file that no lender is actually holding up. On the scheme products above it is mandatory, because there the scheme itself requires it.'),
  ('business_stock_statement', 'Stock statement', '', 'The security itself on a cash-credit limit — assessed, then monitored monthly.'),
  ('business_debtors_creditors', 'Debtors & creditors list', '', 'Ageing of receivables and payables — the working-capital cycle.'),
  ('business_project_report', 'Project report', '', 'A term loan funds a purpose. The report is that purpose, costed.'),
  ('business_machinery_quotation', 'Machinery quotation', '', ''),
  ('business_contract_or_tender', 'Contract or work order', '', 'A bank guarantee is issued against an obligation. This is the obligation.'),
  ('business_invoices', 'Invoices or bills', '', ''),
  ('business_buyer_acceptance', 'Buyer acceptance letter', '', 'Discounting an invoice the buyer has not accepted is lending against hope.'),
  ('property_sale_deed', 'Sale deed (title deed)', '', ''),
  ('property_parent_document', 'Parent documents (previous sale deeds)', '', 'Thirteen to thirty years of chain, depending on the lender''s legal panel.'),
  ('property_patta_chitta', 'Patta & Chitta', '', 'Tamil Nadu revenue ownership record. An apartment on undivided share is the one common case where the patta sits with the land, not the buyer.'),
  ('property_encumbrance_certificate', 'Encumbrance certificate (EC / Villangam)', '', 'Villangam, from the Sub-Registrar. Thirteen years is the usual ask.'),
  ('property_tax_receipt', 'Property tax receipt', '', ''),
  ('property_approved_plan', 'Building approval plan', '', ''),
  ('property_layout_approval', 'Layout approval (DTCP / CMDA)', '', 'An unapproved layout is the most common reason a Tamil Nadu plot file is declined.'),
  ('property_sale_agreement', 'Sale agreement', '', ''),
  ('property_builder_noc', 'Builder NOC / allotment letter', '', ''),
  ('property_occupancy_certificate', 'Occupancy certificate (OC)', '', ''),
  ('property_own_contribution', 'Own contribution (margin money) proof', '', 'The audit added this. Margin is 10–25% by ticket size and no lender disburses without evidence the borrower has paid theirs — a builder''s receipt, or the transfer that funded it. Due at submission, not on day two, because there is usually nothing to show until a property and a price exist.'),
  ('property_legal_opinion', 'Legal opinion', '', 'Produced by the lender''s panel advocate — not due before a lender is chosen.'),
  ('property_valuation_report', 'Property valuation report', '', 'Demanding a valuation on day two, before a property is chosen, makes the checklist wrong and the progress bar useless (Requirements and Progress, Part 3).'),
  ('property_lease_deed', 'Registered lease deed — rent-based loan', '', ''),
  ('property_tenant_kyc', 'Tenant KYC — rent-based loan', '', 'LRD is underwritten on the tenant''s covenant, not the landlord''s income.'),
  ('construction_estimate', 'Construction estimate', '', 'Costed by an engineer or architect. Drives the staged disbursement schedule.'),
  ('construction_progress_report', 'Construction progress report', '', 'Each further tranche is released against progress. Nothing to report before the first brick, so the requirement does not exist yet.'),
  ('vehicle_quotation', 'Vehicle quotation', '', ''),
  ('vehicle_rc', 'Vehicle RC book — second-hand vehicle', '', ''),
  ('vehicle_valuation', 'Vehicle valuation — second-hand vehicle', '', 'Tenure is capped by the vehicle''s age, so the valuation is also an eligibility input.'),
  ('vehicle_route_permit', 'Route permit — commercial vehicle', '', ''),
  ('vehicle_insurance', 'Vehicle insurance', '', ''),
  ('gold_appraisal_note', 'Gold appraisal note', '', 'The appraiser''s weight, purity and valuation. The whole underwriting.'),
  ('education_admission_letter', 'Admission letter', '', ''),
  ('education_fee_structure', 'Fee structure', '', ''),
  ('education_academic_records', 'Academic records (marksheets)', '', ''),
  ('education_passport', 'Passport — study abroad', '', ''),
  ('education_visa', 'Visa — study abroad', '', 'Often granted after sanction. Due late, never treated as missing early.'),
  ('securities_demat_statement', 'Demat / portfolio statement', '', ''),
  ('securities_fd_receipt', 'Fixed deposit receipt', '', ''),
  ('case_application_form', 'Loan application form', '', ''),
  ('case_login_form', 'Bank login form', '', 'The lender''s own form. Not fillable until the lender is chosen.'),
  ('case_nach_mandate', 'NACH mandate / security cheques', '', '')
) as v(code, name, financial_years, notes)
where r.code = v.code;


-- ---------------------------------------------------------------------------
-- Display order resync. Two rules inserted mid-file shift every rule after
-- them, and without this the SQL seed and the prototype would render the same
-- checklist in two different orders.
-- ---------------------------------------------------------------------------

update document_requirement_rule r
set display_order = v.display_order
from (values
  ('kyc_pan', 101),
  ('kyc_aadhaar', 102),
  ('kyc_address_proof', 103),
  ('kyc_photograph', 104),
  ('kyc_signature_proof', 105),
  ('kyc_credit_bureau_consent', 106),
  ('nri_passport', 207),
  ('nri_visa', 208),
  ('nri_overseas_income', 209),
  ('nri_power_of_attorney', 210),
  ('income_salary_slip', 311),
  ('income_form_16', 312),
  ('income_salaried_banking', 313),
  ('income_employment_certificate', 314),
  ('income_appointment_letter', 315),
  ('income_itr', 316),
  ('income_itr_business_promoter', 317),
  ('income_self_employed_banking', 318),
  ('income_form_26as', 319),
  ('income_form_26as_salaried', 320),
  ('income_balance_sheet_individual', 321),
  ('income_profit_and_loss_individual', 322),
  ('income_qualification_proof', 323),
  ('income_practice_proof', 324),
  ('income_practice_proof_professional', 325),
  ('income_business_proof_individual', 326),
  ('guarantor_itr', 327),
  ('guarantor_net_worth', 328),
  ('obligations_loan_statement', 429),
  ('takeover_loan_statement', 430),
  ('takeover_foreclosure_letter', 431),
  ('firm_pan', 532),
  ('firm_address_proof', 533),
  ('firm_business_proof', 534),
  ('firm_bank_statement', 535),
  ('firm_itr', 536),
  ('firm_balance_sheet', 537),
  ('firm_profit_and_loss', 538),
  ('firm_audit_report', 539),
  ('gst_certificate_firm', 540),
  ('gst_returns_firm', 541),
  ('gst_certificate_individual', 542),
  ('gst_returns_individual', 543),
  ('gst_certificate_firm_by_product', 544),
  ('gst_returns_firm_by_product', 545),
  ('gst_certificate_individual_by_product', 546),
  ('gst_returns_individual_by_product', 547),
  ('business_pan_by_product', 748),
  ('business_proof_by_product', 749),
  ('business_address_proof_by_product', 750),
  ('business_banking_by_product', 751),
  ('business_itr_by_product', 752),
  ('business_balance_sheet_by_product', 753),
  ('business_profit_and_loss_by_product', 754),
  ('constitution_partnership_deed', 655),
  ('constitution_llp_agreement', 656),
  ('constitution_incorporation', 657),
  ('constitution_moa_aoa', 658),
  ('constitution_board_resolution', 659),
  ('constitution_director_list', 660),
  ('constitution_shareholding', 661),
  ('constitution_trust_deed', 662),
  ('constitution_society_registration', 663),
  ('business_udyam_scheme', 764),
  ('business_udyam_general', 765),
  ('business_stock_statement', 766),
  ('business_debtors_creditors', 767),
  ('business_project_report', 768),
  ('business_machinery_quotation', 769),
  ('business_contract_or_tender', 770),
  ('business_invoices', 771),
  ('business_buyer_acceptance', 772),
  ('property_sale_deed', 873),
  ('property_parent_document', 874),
  ('property_patta_chitta', 875),
  ('property_encumbrance_certificate', 876),
  ('property_tax_receipt', 877),
  ('property_approved_plan', 878),
  ('property_layout_approval', 879),
  ('property_sale_agreement', 880),
  ('property_builder_noc', 881),
  ('property_occupancy_certificate', 882),
  ('property_own_contribution', 883),
  ('property_legal_opinion', 884),
  ('property_valuation_report', 885),
  ('property_lease_deed', 886),
  ('property_tenant_kyc', 887),
  ('construction_estimate', 988),
  ('construction_progress_report', 989),
  ('vehicle_quotation', 1090),
  ('vehicle_rc', 1091),
  ('vehicle_valuation', 1092),
  ('vehicle_route_permit', 1093),
  ('vehicle_insurance', 1094),
  ('gold_appraisal_note', 1195),
  ('education_admission_letter', 1296),
  ('education_fee_structure', 1297),
  ('education_academic_records', 1298),
  ('education_passport', 1299),
  ('education_visa', 1300),
  ('securities_demat_statement', 1401),
  ('securities_fd_receipt', 1402),
  ('case_application_form', 1503),
  ('case_login_form', 1504),
  ('case_nach_mandate', 1505)
) as v(code, display_order)
where r.code = v.code;
