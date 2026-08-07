-- ===========================================================================
-- 0026 — Telecaller Workflow refinement
--
-- Two things: document types now say what a TELECALLER calls them, and a
-- business loan asks for business documents on day one.
--
-- GENERATED from src/domain/requirements/document-catalogue.ts and
-- default-rules.ts, which stay authoritative — same discipline as 0022 and
-- 0023. Regenerate rather than edit by hand; a name changed here and not
-- there is a checklist that reads differently in the prototype and in
-- production, which is the one failure mode a shared domain layer exists to
-- prevent.
--
-- WHAT WATCHING A TELECALLER USE AOS FOUND
--
--  1. THE NAMES WERE A CREDIT MANAGER'S, NOT A CUSTOMER'S. "Credit Bureau
--     Consent", "Application Form", "Parent Document (Title Chain)" are all
--     correct and none of them is a sentence anyone says on the phone in
--     Coimbatore. Every name is rewritten; each type now also carries the
--     COMMON LOCAL NAME where Tamil Nadu has one (EC / Villangam, Udyog
--     Aadhaar, CIBIL Consent), a one-sentence description a first-week joiner
--     can read out, and a CATEGORY so the checklist is six labelled blocks
--     rather than one flat list of forty rows.
--  2. A BUSINESS LOAN HAD THE EMPTIEST CHECKLIST. Every business rule waited
--     for a borrowing firm to be added or an employment type to be set, and
--     both start NULL — so the newest business loan in the system asked for
--     PAN, Aadhaar, a photo and nothing else, at exactly the moment the
--     telecaller needed the list. Six new rules key on the customer product
--     itself: if someone opened a business loan, there is a business. They
--     stand down the moment a real firm is added.
--  3. GST BY PRODUCT STILL WAITED ON THE EMPLOYMENT TYPE. The two individual
--     by-product rules from 0023 carried `party.employment_type in
--     (self_employed, business_owner)`, which reintroduced the NULL wait the
--     rest of that migration removed. Dropped, and the rules narrowed from
--     every income-supplying party to the applicant: a salaried co-applicant
--     on a Commercial LAP has no GSTIN to produce.
--  4. TWO YEARS OF GST RETURNS, NOT ONE. Lenders read GSTR-3B to see whether
--     turnover is growing. One year shows a number; two show a trend.
--
-- Plus the schema for requirements a Login Executive adds BY HAND on one case
-- — the exception the rules could not have known about. No master rule is
-- touched by adding one, and regeneration leaves it alone.
--
-- Every row here remains a DEFAULT, editable by a business user afterwards.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Schema: how a document presents itself.
-- ---------------------------------------------------------------------------

create type app.document_category as enum (
  'kyc',
  'income',
  'business',
  'financial',
  'property',
  'additional'
);

comment on type app.document_category is
  'Which block of the checklist a document appears under. A telecaller reads '
  'a checklist ALOUD, one topic at a time; the grouping is what lets them say '
  '"now the business papers" instead of reading forty rows back item by item.';

alter table document_type
  add column local_name text,
  add column category   app.document_category not null default 'additional';

comment on column document_type.local_name is
  'What this document is called locally when that differs from the official '
  'name — "EC / Villangam", "Udyog Aadhaar", "CIBIL Consent". Shown BESIDE '
  'the official name, never instead of it: the customer says one and the bank '
  'wants the other, and the person on the phone needs both in front of them.';

-- ---------------------------------------------------------------------------
-- Schema: requirements added by hand, for one case (Part 6).
--
-- A rule pack cannot anticipate everything — one bank asks for one extra
-- letter on one file. The tempting fix is to add a rule, and a rule added for
-- one file quietly changes what every other open case asks for, which is how
-- a rules engine becomes something users are afraid of.
--
-- So the row carries its own name, description and category rather than
-- getting a document_type of its own (per-case master data nobody owns), and
-- points at 'other_document' so upload, versioning and verification work on
-- it exactly as they work on a generated requirement. A custom document that
-- cannot be verified is a sticky note, and a sticky note is what this
-- replaces.
-- ---------------------------------------------------------------------------

alter table document_requirement
  add column is_custom          boolean not null default false,
  add column custom_name        text,
  add column custom_description text,
  add column custom_category    app.document_category;

comment on column document_requirement.is_custom is
  'Added by hand by a Login Executive, for this case only. No rule produced '
  'it, so no rule''s absence may withdraw it: regeneration passes these rows '
  'through untouched, and withdrawing one marks it not_applicable rather than '
  'deleting it (BR-034).';

alter table document_requirement
  add constraint document_requirement_custom_needs_a_name
  check (not is_custom or custom_name is not null);


-- ---------------------------------------------------------------------------
-- Every document type, in a telecaller's words. Inserted where new, updated
-- where the wording changed — a business user who has already renamed one
-- gets their wording back, because this is a default and not an enforcement.
-- ---------------------------------------------------------------------------

insert into document_type (code, name, local_name, owner_kind, requires_period, requires_expiry, description, category, display_order) values
  ('pan_card', 'PAN Card', null, 'person', false, false, 'The customer''s own PAN card. Every lender asks for it and none of them waive it.', 'kyc', 10),
  ('aadhaar_card', 'Aadhaar Card', null, 'person', false, false, 'Front and back. Serves as both identity and address proof for most lenders.', 'kyc', 20),
  ('address_proof', 'Address Proof', null, 'person', false, true, 'Any one of: EB bill, gas bill, ration card, passport, driving licence or a rental agreement — in the customer''s name and not more than three months old.', 'kyc', 30),
  ('photograph', 'Passport Size Photograph', null, 'person', false, false, 'One recent passport size photo. A clear phone photo of the print is enough to start.', 'kyc', 40),
  ('salary_slip', 'Salary Slip', 'Payslip', 'person', true, false, 'Last three months'' payslips. Six months where the salary includes incentive or overtime.', 'income', 50),
  ('form_16', 'Form 16', null, 'person', true, false, 'The employer''s annual salary and TDS certificate, one per financial year.', 'income', 60),
  ('bank_statement', 'Bank Statement', null, 'person', true, false, 'Statement of the account the salary or business income comes into. Six months for salaried, twelve for self-employed. A PDF from net banking is accepted.', 'financial', 70),
  ('itr', 'Income Tax Return (ITR)', null, 'person', true, false, 'ITR with the computation sheet, one per assessment year. Usually the last two years.', 'income', 80),
  ('gst_certificate', 'GST Registration Certificate (GST REG-06)', null, 'organisation', false, false, 'The certificate issued when the business registered for GST. It carries the GSTIN.', 'business', 90),
  ('gst_returns', 'GST Returns (GSTR-3B)', null, 'organisation', true, false, 'The monthly GST return. Lenders read the last twelve months to see real turnover, so ask for a full financial year at a time.', 'business', 110),
  ('balance_sheet', 'Balance Sheet', null, 'organisation', true, false, 'The year-end statement of what the business owns and owes, signed by the auditor or CA.', 'financial', 120),
  ('profit_and_loss', 'Profit & Loss Statement', 'P&L Account', 'organisation', true, false, 'The year''s income and expenses, signed by the auditor or CA. Filed with the balance sheet.', 'financial', 130),
  ('sale_deed', 'Sale Deed', 'Title Deed', 'property', false, false, 'The registered deed by which the current owner bought the property.', 'property', 140),
  ('encumbrance_cert', 'Encumbrance Certificate', 'EC / Villangam', 'property', true, false, 'The Sub-Registrar''s record of every sale and loan registered on the property. Banks ask for the last thirteen years.', 'property', 150),
  ('approved_plan', 'Building Approval Plan', 'Plan Approval', 'property', false, false, 'The building plan sanctioned by the panchayat, municipality, CMDA or DTCP.', 'property', 160),
  ('valuation_report', 'Property Valuation Report', null, 'property', false, true, 'The bank''s own valuer visits and values the property. Arranged after the bank is chosen.', 'property', 170),
  ('login_form', 'Bank Login Form', null, 'case', false, false, 'The bank''s own application form, signed. Only available once a bank has been chosen.', 'additional', 180),
  ('sanction_letter', 'Sanction Letter', null, 'case', false, true, 'The bank''s letter confirming the approved amount and terms.', 'additional', 190),
  ('signature_proof', 'Signature Proof', null, 'person', false, false, 'A specimen signature on a blank sheet, asked for when the signature on the PAN is unclear.', 'kyc', 200),
  ('credit_bureau_consent', 'Loan Consent Form', 'CIBIL Consent', 'person', false, false, 'The customer''s signed permission to check their CIBIL score. We cannot check it without this.', 'kyc', 210),
  ('passport', 'Passport', null, 'person', false, true, 'Photo page and address page. Needed for NRI customers and for study-abroad loans.', 'kyc', 220),
  ('visa', 'Visa / Work Permit', null, 'person', false, true, 'The current visa or work permit page, for a customer living or studying abroad.', 'kyc', 230),
  ('power_of_attorney', 'Power of Attorney (POA)', null, 'person', false, false, 'A registered POA given to a relative in India, so papers can be signed here while the customer is abroad.', 'kyc', 240),
  ('employment_certificate', 'Employment Certificate', 'Job Certificate', 'person', false, false, 'A letter from the employer confirming the designation, how long they have worked there, and the salary.', 'income', 250),
  ('appointment_letter', 'Appointment Letter', 'Offer Letter', 'person', false, false, 'The joining letter from the employer. Asked for when the customer has joined recently.', 'income', 260),
  ('qualification_proof', 'Qualification Certificate', 'Degree Certificate', 'person', false, false, 'The degree or professional certificate — doctor, CA, engineer. A professional loan is given on the strength of it.', 'income', 270),
  ('professional_practice_proof', 'Practice Proof', null, 'person', false, false, 'Proof of how long they have practised — council registration, clinic licence or association membership.', 'income', 280),
  ('overseas_income_proof', 'Overseas Income Proof', null, 'person', true, false, 'Foreign payslips or the employment contract for an NRI customer. Usually needs attestation.', 'income', 290),
  ('net_worth_statement', 'Net Worth Statement', null, 'person', false, false, 'A CA''s list of what the guarantor owns and owes. A guarantee is worth what the guarantor is worth.', 'financial', 300),
  ('existing_loan_statement', 'Existing Loan Statement', 'Loan Account Statement', 'person', true, false, 'Statement of any loan the customer is already repaying, showing the EMI and how regularly it is paid.', 'financial', 310),
  ('foreclosure_letter', 'Foreclosure Letter', 'Closure Quote', 'person', false, true, 'The existing bank''s letter stating the exact amount needed to close the loan. It expires quickly, so ask for it late.', 'financial', 320),
  ('org_pan', 'Business PAN Card', null, 'organisation', false, false, 'The firm''s own PAN card. A proprietorship uses the owner''s personal PAN instead.', 'business', 330),
  ('org_address_proof', 'Business Address Proof', null, 'organisation', false, false, 'EB bill, rental agreement or lease deed in the business''s name, not more than three months old.', 'business', 340),
  ('business_proof', 'Business Proof', null, 'organisation', false, false, 'Anything that shows the business is real and running — Shop & Establishment licence, trade licence, or the registration deed.', 'business', 350),
  ('udyam_certificate', 'Udyam Registration Certificate', 'Udyog Aadhaar / MSME Certificate', 'organisation', false, false, 'The MSME registration certificate. Compulsory for MUDRA and CGTMSE loans, and useful on every other business loan.', 'business', 360),
  ('org_itr', 'Business ITR', null, 'organisation', true, false, 'The firm''s own income tax return with computation, one per assessment year. Separate from the owner''s personal ITR.', 'business', 370),
  ('org_bank_statement', 'Business Bank Statement', 'Current Account Statement', 'organisation', true, false, 'Twelve months of the business current account. This is what the bank reads to judge daily turnover.', 'financial', 380),
  ('audit_report', 'Audit Report', null, 'organisation', true, false, 'The auditor''s report for the year. Companies and LLPs have one; a small proprietorship usually does not.', 'financial', 390),
  ('stock_statement', 'Stock Statement', null, 'organisation', true, false, 'A list of stock in hand and money customers owe. This is the security on a cash credit limit.', 'business', 400),
  ('debtors_creditors_statement', 'Debtors & Creditors List', null, 'organisation', true, false, 'Who owes the business money and whom it owes, with how long each has been outstanding.', 'business', 410),
  ('project_report', 'Project Report', null, 'organisation', false, false, 'A written plan of what the loan will be spent on, with costs. Usually prepared by a CA.', 'business', 420),
  ('machinery_quotation', 'Machinery Quotation', null, 'organisation', false, false, 'The supplier''s price quotation for the machine being bought.', 'business', 430),
  ('contract_or_tender', 'Contract / Work Order', 'Tender Document', 'organisation', false, false, 'The order or contract the bank guarantee or letter of credit is being taken for.', 'business', 440),
  ('invoice_bills', 'Invoices / Bills', null, 'organisation', false, false, 'The bills being discounted.', 'business', 450),
  ('buyer_acceptance', 'Buyer Acceptance Letter', null, 'organisation', false, false, 'The buyer''s written confirmation that they accept the invoice and will pay it.', 'business', 460),
  ('partnership_deed', 'Partnership Deed', null, 'organisation', false, false, 'The registered deed naming the current partners and their shares.', 'business', 470),
  ('llp_agreement', 'LLP Agreement', null, 'organisation', false, false, 'The LLP''s agreement as filed with the Registrar.', 'business', 480),
  ('certificate_of_incorporation', 'Certificate of Incorporation', 'Company Registration Certificate', 'organisation', false, false, 'The Registrar of Companies certificate issued when the company was formed.', 'business', 490),
  ('moa_aoa', 'MOA & AOA', null, 'organisation', false, false, 'The company''s Memorandum and Articles of Association. These say whether the company is allowed to borrow.', 'business', 500),
  ('board_resolution', 'Board Resolution', null, 'organisation', false, false, 'The board''s written decision to take this loan and who may sign for it.', 'business', 510),
  ('list_of_directors', 'List of Directors / Partners', null, 'organisation', false, false, 'The current directors or partners with their DIN, as filed.', 'business', 520),
  ('shareholding_pattern', 'Shareholding Pattern', null, 'organisation', false, false, 'Who owns the company and what percentage each holds.', 'business', 530),
  ('trust_deed', 'Trust Deed', null, 'organisation', false, false, 'The deed that created the trust and states its borrowing powers.', 'business', 540),
  ('society_registration', 'Society Registration Certificate', null, 'organisation', false, false, 'The society''s registration certificate from the Registrar of Societies.', 'business', 550),
  ('sale_agreement', 'Sale Agreement', 'Agreement to Sell', 'property', false, false, 'The written agreement with the seller, before registration. It fixes the price the loan is calculated on.', 'property', 560),
  ('parent_document', 'Parent Documents', 'Previous Sale Deeds', 'property', false, false, 'The older sale deeds showing who owned the property before. Banks ask for thirteen to thirty years of them.', 'property', 570),
  ('patta_chitta', 'Patta & Chitta', null, 'property', false, false, 'The Tamil Nadu land record. Patta shows who owns the land, Chitta shows what kind of land it is. Downloadable from the e-Services portal.', 'property', 580),
  ('property_tax_receipt', 'Property Tax Receipt', 'House Tax Receipt', 'property', true, false, 'The latest paid tax receipt from the panchayat or corporation.', 'property', 590),
  ('layout_approval', 'Layout Approval', 'DTCP / CMDA Approval', 'property', false, false, 'The approved layout for a plot, from DTCP, CMDA or the local body. An unapproved layout is the commonest reason a plot loan is refused.', 'property', 600),
  ('construction_estimate', 'Construction Estimate', 'Engineer''s Estimate', 'property', false, false, 'The engineer''s or architect''s costing of the building work. The bank releases money in stages against it.', 'property', 610),
  ('construction_progress_report', 'Construction Progress Report', 'Stage Certificate', 'property', true, false, 'The engineer''s certificate of how much of the building is finished. Each further release needs a fresh one.', 'property', 620),
  ('legal_opinion', 'Legal Opinion', null, 'property', false, false, 'The bank''s own lawyer checks the title and gives an opinion. Arranged after the bank is chosen.', 'property', 630),
  ('occupancy_certificate', 'Occupancy Certificate', 'OC / Completion Certificate', 'property', false, false, 'The local body''s certificate that the finished building may be lived in.', 'property', 640),
  ('builder_noc', 'Builder NOC / Allotment Letter', null, 'property', false, false, 'The builder''s no-objection letter and allotment letter, when buying from a builder.', 'property', 650),
  ('lease_deed', 'Registered Lease Deed', null, 'property', false, false, 'The registered lease for the property whose rent is being lent against.', 'property', 660),
  ('vehicle_quotation', 'Vehicle Quotation', 'Proforma Invoice', 'case', false, false, 'The dealer''s price quotation for the vehicle being bought.', 'additional', 670),
  ('vehicle_rc', 'Vehicle RC Book', null, 'case', false, false, 'The RC of a second-hand vehicle. The bank''s name is added to it after the loan is given.', 'additional', 680),
  ('vehicle_valuation', 'Vehicle Valuation Report', null, 'case', false, false, 'A valuer''s report on a second-hand vehicle. The vehicle''s age limits how long the loan can run.', 'additional', 690),
  ('vehicle_insurance', 'Vehicle Insurance', null, 'case', false, true, 'Full (comprehensive) insurance with the bank''s name added on it.', 'additional', 700),
  ('route_permit', 'Route Permit', null, 'case', false, true, 'The permit for a goods or passenger commercial vehicle.', 'additional', 710),
  ('gold_appraisal_note', 'Gold Appraisal Note', 'Appraiser''s Slip', 'case', false, false, 'The appraiser''s note of the weight, purity and value of the ornaments. On a gold loan this is the whole file.', 'additional', 720),
  ('admission_letter', 'Admission Letter', null, 'person', false, false, 'The college''s confirmed admission offer.', 'additional', 730),
  ('fee_structure', 'Fee Structure', null, 'person', false, false, 'The college''s fee schedule for the course. It decides how much can be sanctioned.', 'additional', 740),
  ('academic_records', 'Academic Records', 'Marksheets', 'person', false, false, 'Marksheets and entrance exam results.', 'additional', 750),
  ('demat_statement', 'Demat / Portfolio Statement', null, 'person', true, false, 'Statement of the shares or mutual funds being pledged, with today''s value.', 'financial', 760),
  ('fd_receipt', 'Fixed Deposit Receipt', 'FD Receipt', 'person', false, false, 'The deposit receipt being pledged for the loan.', 'financial', 770),
  ('application_form', 'Loan Application Form', null, 'case', false, false, 'Our own application form, filled and signed by the customer. Separate from the bank''s login form.', 'additional', 780),
  ('nach_mandate', 'NACH Mandate / Security Cheques', 'ECS Mandate', 'case', false, false, 'The signed EMI auto-debit mandate and any blank cheques the bank asks for.', 'additional', 790),
  ('tenant_kyc', 'Tenant KYC', null, 'case', false, false, 'Identity and agreement papers of the tenant paying the rent, for a rent-based loan.', 'additional', 800),
  ('form_26as', 'Form 26AS / AIS', 'Tax Credit Statement', 'person', true, false, 'The income tax department''s own record of income and TDS, downloaded from the income tax portal. Banks compare it against the ITR.', 'income', 810),
  ('own_contribution_proof', 'Own Contribution Proof', 'Margin Money Proof', 'case', false, false, 'Proof the customer has paid their own share — the builder''s or seller''s receipt, or the bank transfer that paid it.', 'financial', 820),
  ('other_document', 'Other Document', null, 'case', false, false, 'A document asked for on this case only, added by hand because the standard list did not cover it.', 'additional', 900)
on conflict (code) do update set
  name          = excluded.name,
  local_name    = excluded.local_name,
  description   = excluded.description,
  category      = excluded.category,
  display_order = excluded.display_order;


-- ---------------------------------------------------------------------------
-- The business-loan set, asked for because the product is a business loan and
-- for no other reason. Columns as in 0022.
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
  ('business_proof_by_product', 'Business proof — business loan', 'business_proof', 'party', 'applicant', 'person', '', 'mandatory', 'documents_pending', '', 'all', '747', 'Shop & Establishment licence, trade licence or the registration deed. Asked because the loan is a business loan, not because anyone has yet said what kind of business it is.'),
  ('business_address_proof_by_product', 'Business address proof — business loan', 'org_address_proof', 'party', 'applicant', 'person', '', 'mandatory', 'documents_pending', '', 'all', '748', 'EB bill or rental agreement for the shop or office, dated within three months.'),
  ('business_banking_by_product', 'Business bank statement (current account) — business loan', 'org_bank_statement', 'party', 'applicant', 'person', '', 'mandatory', 'documents_pending', '1', 'all', '749', 'Twelve months of the business account. On a proprietorship this is often the same account as the personal one, and the telecaller should ask for whichever the takings go into.'),
  ('business_itr_by_product', 'ITR — business loan', 'itr', 'party', 'applicant', 'person', '', 'mandatory', 'documents_pending', '2', 'all', '750', 'Two assessment years with computation. On a proprietorship the business ITR is the owner''s ITR.'),
  ('business_balance_sheet_by_product', 'Balance sheet — business loan', 'balance_sheet', 'party', 'applicant', 'person', '', 'mandatory', 'documents_pending', '2', 'all', '751', ''),
  ('business_profit_and_loss_by_product', 'Profit & loss statement — business loan', 'profit_and_loss', 'party', 'applicant', 'person', '', 'mandatory', 'documents_pending', '2', 'all', '752', '')
) as v(code, name, document_type_code, scope, party_roles, party_kind,
       property_roles, applicability, stage, financial_years, condition_match,
       display_order, notes)
join document_type dt on dt.code = v.document_type_code
join requirement_applicability ra on ra.code = v.applicability
on conflict (code) do nothing;


-- ---------------------------------------------------------------------------
-- Conditions: for the six new rules, and for the two 0023 rules whose
-- conditions changed. The two are cleared first — replacing rather than
-- appending is what makes this migration idempotent, and they are named
-- explicitly so a rule a business user has since edited is never touched.
-- ---------------------------------------------------------------------------

delete from document_requirement_rule_condition
where rule_id in (
  select id from document_requirement_rule
  where code in ('gst_certificate_individual_by_product', 'gst_returns_individual_by_product')
);

insert into document_requirement_rule_condition (rule_id, fact, operator, values, display_order)
select
  r.id,
  v.fact,
  v.operator::app.rule_condition_operator,
  case when v.vals = '' then null else string_to_array(v.vals, '|') end,
  v.display_order::integer
from (values
  ('business_proof_by_product', 'case.customer_product_code', 'in', 'business_loan', '10'),
  ('business_proof_by_product', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('business_address_proof_by_product', 'case.customer_product_code', 'in', 'business_loan', '10'),
  ('business_address_proof_by_product', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('business_banking_by_product', 'case.customer_product_code', 'in', 'business_loan', '10'),
  ('business_banking_by_product', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('business_itr_by_product', 'case.customer_product_code', 'in', 'business_loan', '10'),
  ('business_itr_by_product', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('business_balance_sheet_by_product', 'case.customer_product_code', 'in', 'business_loan', '10'),
  ('business_balance_sheet_by_product', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('business_profit_and_loss_by_product', 'case.customer_product_code', 'in', 'business_loan', '10'),
  ('business_profit_and_loss_by_product', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('gst_certificate_individual_by_product', 'case.gst_requirement', 'equals', 'mandatory', '10'),
  ('gst_certificate_individual_by_product', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('gst_returns_individual_by_product', 'case.gst_requirement', 'equals', 'mandatory', '10'),
  ('gst_returns_individual_by_product', 'case.has_borrower_firm', 'is_false', '', '20')
) as v(rule_code, fact, operator, vals, display_order)
join document_requirement_rule r on r.code = v.rule_code
on conflict do nothing;


-- The two GST-by-product individual rules narrow from every income-supplying
-- party to the applicant. A salaried co-applicant on a Commercial LAP has no
-- GSTIN, and asking them for one is the over-ask that makes a checklist look
-- like it was written by someone who has never seen a file.

update document_requirement_rule
set party_roles = array['applicant']::app.case_party_role[]
where code in ('gst_certificate_individual_by_product', 'gst_returns_individual_by_product');


-- ---------------------------------------------------------------------------
-- Every rule's NAME, in a telecaller's words.
--
-- The rule name is what appears under "Asked for by" on the case screen — the
-- answer to "why am I being asked for this?". A name only a credit manager
-- understands is a name the person on the phone has to translate live,
-- differently every time.
--
-- Financial years travel with the name because the GST returns rules changed
-- from one year to two in the same pass.
-- ---------------------------------------------------------------------------

update document_requirement_rule r
set name           = v.name,
    financial_years = nullif(v.financial_years, '')::smallint,
    notes          = nullif(v.notes, '')
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
  ('business_udyam_general', 'Udyam registration (MSME) — other business loans', '', ''),
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
-- Display order resync.
--
-- The pack's order is declaration order in default-rules.ts, so inserting six
-- rules mid-file shifts every rule after them. Without this the SQL seed and
-- the prototype would render the same checklist in two different orders — the
-- drift 0022's header warns about.
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
  ('income_self_employed_banking', 317),
  ('income_form_26as', 318),
  ('income_form_26as_salaried', 319),
  ('income_balance_sheet_individual', 320),
  ('income_profit_and_loss_individual', 321),
  ('income_qualification_proof', 322),
  ('income_practice_proof', 323),
  ('income_practice_proof_professional', 324),
  ('income_business_proof_individual', 325),
  ('guarantor_itr', 326),
  ('guarantor_net_worth', 327),
  ('obligations_loan_statement', 428),
  ('takeover_loan_statement', 429),
  ('takeover_foreclosure_letter', 430),
  ('firm_pan', 531),
  ('firm_address_proof', 532),
  ('firm_business_proof', 533),
  ('firm_bank_statement', 534),
  ('firm_itr', 535),
  ('firm_balance_sheet', 536),
  ('firm_profit_and_loss', 537),
  ('firm_audit_report', 538),
  ('gst_certificate_firm', 539),
  ('gst_returns_firm', 540),
  ('gst_certificate_individual', 541),
  ('gst_returns_individual', 542),
  ('gst_certificate_firm_by_product', 543),
  ('gst_returns_firm_by_product', 544),
  ('gst_certificate_individual_by_product', 545),
  ('gst_returns_individual_by_product', 546),
  ('business_proof_by_product', 747),
  ('business_address_proof_by_product', 748),
  ('business_banking_by_product', 749),
  ('business_itr_by_product', 750),
  ('business_balance_sheet_by_product', 751),
  ('business_profit_and_loss_by_product', 752),
  ('constitution_partnership_deed', 653),
  ('constitution_llp_agreement', 654),
  ('constitution_incorporation', 655),
  ('constitution_moa_aoa', 656),
  ('constitution_board_resolution', 657),
  ('constitution_director_list', 658),
  ('constitution_shareholding', 659),
  ('constitution_trust_deed', 660),
  ('constitution_society_registration', 661),
  ('business_udyam_scheme', 762),
  ('business_udyam_general', 763),
  ('business_stock_statement', 764),
  ('business_debtors_creditors', 765),
  ('business_project_report', 766),
  ('business_machinery_quotation', 767),
  ('business_contract_or_tender', 768),
  ('business_invoices', 769),
  ('business_buyer_acceptance', 770),
  ('property_sale_deed', 871),
  ('property_parent_document', 872),
  ('property_patta_chitta', 873),
  ('property_encumbrance_certificate', 874),
  ('property_tax_receipt', 875),
  ('property_approved_plan', 876),
  ('property_layout_approval', 877),
  ('property_sale_agreement', 878),
  ('property_builder_noc', 879),
  ('property_occupancy_certificate', 880),
  ('property_own_contribution', 881),
  ('property_legal_opinion', 882),
  ('property_valuation_report', 883),
  ('property_lease_deed', 884),
  ('property_tenant_kyc', 885),
  ('construction_estimate', 986),
  ('construction_progress_report', 987),
  ('vehicle_quotation', 1088),
  ('vehicle_rc', 1089),
  ('vehicle_valuation', 1090),
  ('vehicle_route_permit', 1091),
  ('vehicle_insurance', 1092),
  ('gold_appraisal_note', 1193),
  ('education_admission_letter', 1294),
  ('education_fee_structure', 1295),
  ('education_academic_records', 1296),
  ('education_passport', 1297),
  ('education_visa', 1298),
  ('securities_demat_statement', 1399),
  ('securities_fd_receipt', 1400),
  ('case_application_form', 1501),
  ('case_login_form', 1502),
  ('case_nach_mandate', 1503)
) as v(code, display_order)
where r.code = v.code;
