-- ===========================================================================
-- 0022 — Seed: document types and the default requirement rule pack
--
-- Data only. Every row here is a DEFAULT, editable by a business user
-- afterwards through the Master Data and Document Rules screens — nothing in
-- this file is enforced by code.
--
-- GENERATED from src/domain/requirements/default-rules.ts and
-- document-catalogue.ts, which are authoritative. The prototype's in-memory
-- store seeds itself from the same two modules, so the SQL seed, the
-- prototype and the engine cannot drift apart. Regenerate rather than edit by
-- hand; a rule changed here and not there is a rule that behaves differently
-- in the prototype and in production, which is the one failure mode a shared
-- domain layer exists to prevent.
--
-- Research basis for these defaults is summarised in
-- Docs/Document Requirement Engine.md and in the header of default-rules.ts.
-- Sources are Indian lender and NBFC published checklists plus Tamil Nadu
-- registration-department practice; the trailing-year counts (2 years ITR and
-- financials, 1 year GST returns, rolling 6–12 months banking) are market
-- norms, not any single lender's policy.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Document types the engine introduced. The eighteen that existed before it
-- (0009, 0011) are untouched.
-- ---------------------------------------------------------------------------

insert into document_type (code, name, owner_kind, requires_period, requires_expiry, description, display_order) values
  ('signature_proof', 'Signature Proof', 'person', false, false, 'Specimen signature, where the PAN signature is unclear.', 200),
  ('credit_bureau_consent', 'Credit Bureau Consent', 'person', false, false, 'Written consent to pull a credit bureau report. A pull without it is not a shortcut, it is a breach.', 210),
  ('passport', 'Passport', 'person', false, true, 'Identity and, for NRI and overseas-education files, the residence evidence.', 220),
  ('visa', 'Visa / Work Permit', 'person', false, true, 'Current visa or work permit for an NRI borrower or an overseas student.', 230),
  ('power_of_attorney', 'Power of Attorney', 'person', false, false, 'Registered POA, usually to a resident relative, so documents can be executed in India.', 240),
  ('employment_certificate', 'Employment Certificate', 'person', false, false, 'Employer''s confirmation of designation, tenure and salary.', 250),
  ('appointment_letter', 'Appointment Letter', 'person', false, false, 'Asked for where employment vintage is short.', 260),
  ('qualification_proof', 'Qualification Certificate', 'person', false, false, 'Degree or professional qualification. A professional loan is priced off it.', 270),
  ('professional_practice_proof', 'Professional Practice Proof', 'person', false, false, 'Practice vintage — registration, clinic licence, professional body membership.', 280),
  ('overseas_income_proof', 'Overseas Income Proof', 'person', true, false, 'Overseas payslips or employment contract, usually attested, for an NRI borrower.', 290),
  ('net_worth_statement', 'Net Worth Statement', 'person', false, false, 'Assets and liabilities, usually certified. A guarantee is worth what the guarantor is worth.', 300),
  ('existing_loan_statement', 'Existing Loan Statement', 'person', true, false, 'Repayment track on a live facility — the obligations half of FOIR.', 310),
  ('foreclosure_letter', 'Foreclosure Letter', 'person', false, true, 'The existing lender''s payoff quote for a takeover. Dated and short-lived.', 320),
  ('org_pan', 'Business PAN Card', 'organisation', false, false, 'The firm''s own PAN. A proprietorship uses the proprietor''s.', 330),
  ('org_address_proof', 'Business Address Proof', 'organisation', false, false, 'Utility bill or lease in the business''s name, dated within three months.', 340),
  ('business_proof', 'Business Registration Proof', 'organisation', false, false, 'Shop & Establishment registration, trade licence, or the constitution document itself.', 350),
  ('udyam_certificate', 'Udyam Registration Certificate', 'organisation', false, false, 'MSME registration. Mandatory for CGTMSE and PMMY; useful evidence everywhere else.', 360),
  ('org_itr', 'Business Income Tax Return', 'organisation', true, false, 'Per financial year, with computation. Distinct from the proprietor''s personal ITR.', 370),
  ('org_bank_statement', 'Business Bank Statement', 'organisation', true, false, 'Current account, twelve months. The working-capital assessment reads this.', 380),
  ('audit_report', 'Audit Report', 'organisation', true, false, 'Per financial year, for constitutions that are audited. A small proprietorship has none.', 390),
  ('stock_statement', 'Stock and Book Debts Statement', 'organisation', true, false, 'The security itself on a cash-credit limit — assessed at sanction, monitored monthly after.', 400),
  ('debtors_creditors_statement', 'Debtors and Creditors Statement', 'organisation', true, false, 'Ageing of receivables and payables — the working-capital cycle.', 410),
  ('project_report', 'Project Report', 'organisation', false, false, 'A term loan funds a purpose. This is that purpose, costed.', 420),
  ('machinery_quotation', 'Machinery Quotation', 'organisation', false, false, 'Supplier''s quotation for the plant or equipment being financed.', 430),
  ('contract_or_tender', 'Contract or Tender Document', 'organisation', false, false, 'The obligation a bank guarantee or letter of credit is issued against.', 440),
  ('invoice_bills', 'Invoices / Bills', 'organisation', false, false, 'The invoices being discounted.', 450),
  ('buyer_acceptance', 'Buyer Acceptance', 'organisation', false, false, 'The buyer''s acceptance of the invoice. Discounting without it is lending against hope.', 460),
  ('partnership_deed', 'Partnership Deed', 'organisation', false, false, 'Registered deed with the current partners and their shares.', 470),
  ('llp_agreement', 'LLP Agreement', 'organisation', false, false, 'The LLP''s governing agreement, as filed.', 480),
  ('certificate_of_incorporation', 'Certificate of Incorporation', 'organisation', false, false, 'Registrar of Companies incorporation certificate.', 490),
  ('moa_aoa', 'MOA and AOA', 'organisation', false, false, 'Memorandum and Articles of Association. The borrowing powers live here.', 500),
  ('board_resolution', 'Board Resolution', 'organisation', false, false, 'A company borrows by resolution. Without it nobody on the file has authority to sign.', 510),
  ('list_of_directors', 'List of Directors / Partners', 'organisation', false, false, 'Current directors or partners with DIN, as filed.', 520),
  ('shareholding_pattern', 'Shareholding Pattern', 'organisation', false, false, 'Who owns the company, and in what proportion.', 530),
  ('trust_deed', 'Trust Deed', 'organisation', false, false, 'The trust''s constituting deed and its borrowing powers.', 540),
  ('society_registration', 'Society Registration Certificate', 'organisation', false, false, 'Registration under the relevant Societies Registration Act.', 550),
  ('sale_agreement', 'Sale Agreement', 'property', false, false, 'The agreement to sell, ahead of the deed. Fixes the consideration the funding ratio is applied to.', 560),
  ('parent_document', 'Parent Document (Title Chain)', 'property', false, false, 'Prior title deeds. Thirteen to thirty years of chain, depending on the lender''s legal panel.', 570),
  ('patta_chitta', 'Patta / Chitta', 'property', false, false, 'Tamil Nadu revenue ownership record and land classification. Every TN legal opinion turns on it.', 580),
  ('property_tax_receipt', 'Property Tax Receipt', 'property', true, false, 'Latest paid receipt from the local body — evidence of possession as much as of payment.', 590),
  ('layout_approval', 'Layout Approval (DTCP / CMDA / Local Body)', 'property', false, false, 'Approved layout for a plot. An unapproved layout is the commonest reason a TN plot file is declined.', 600),
  ('construction_estimate', 'Construction Estimate', 'property', false, false, 'Costed by an engineer or architect. Drives the staged disbursement schedule.', 610),
  ('construction_progress_report', 'Construction Progress Report', 'property', true, false, 'Stage certificate against which each further tranche is released.', 620),
  ('legal_opinion', 'Legal Opinion', 'property', false, false, 'The lender''s panel advocate''s opinion on title. Not producible before a lender is chosen.', 630),
  ('occupancy_certificate', 'Occupancy Certificate', 'property', false, false, 'Local body''s certificate that the completed building may be occupied.', 640),
  ('builder_noc', 'Builder NOC / Allotment Letter', 'property', false, false, 'Builder''s no-objection and allotment, for a purchase from a developer.', 650),
  ('lease_deed', 'Registered Lease Deed', 'property', false, false, 'For lease rental discounting — the rent being lent against.', 660),
  ('vehicle_quotation', 'Vehicle Quotation / Proforma Invoice', 'case', false, false, 'Dealer''s quotation for the vehicle being financed.', 670),
  ('vehicle_rc', 'Vehicle Registration Certificate', 'case', false, false, 'RC of a used vehicle, with the hypothecation endorsement after disbursement.', 680),
  ('vehicle_valuation', 'Vehicle Valuation Report', 'case', false, false, 'Valuation of a used vehicle. Tenure is capped by the vehicle''s age.', 690),
  ('vehicle_insurance', 'Vehicle Insurance', 'case', false, true, 'Comprehensive cover with the lender endorsed.', 700),
  ('route_permit', 'Route Permit', 'case', false, true, 'Permit for a goods or passenger commercial vehicle.', 710),
  ('gold_appraisal_note', 'Gold Appraisal Note', 'case', false, false, 'The appraiser''s weight, purity and valuation. On a gold loan this is the whole underwriting.', 720),
  ('admission_letter', 'Admission Letter', 'person', false, false, 'Institution''s confirmed admission offer.', 730),
  ('fee_structure', 'Fee Structure', 'person', false, false, 'Institution''s fee schedule for the course. Sets the sanction amount.', 740),
  ('academic_records', 'Academic Records', 'person', false, false, 'Marksheets and entrance results.', 750),
  ('demat_statement', 'Demat / Portfolio Statement', 'person', true, false, 'Holdings being pledged, with current value.', 760),
  ('fd_receipt', 'Fixed Deposit Receipt', 'person', false, false, 'The deposit being lent against.', 770),
  ('application_form', 'Application Form', 'case', false, false, 'Amaze''s own signed application. Distinct from the lender''s login form.', 780),
  ('nach_mandate', 'NACH Mandate / Security Cheques', 'case', false, false, 'Repayment mandate and any security cheques the lender takes.', 790),
  ('tenant_kyc', 'Tenant KYC', 'case', false, false, 'For lease rental discounting, which is underwritten on the tenant''s covenant.', 800)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- The default rule pack.
--
-- Columns, in order: code, name, document type code, scope, party roles
-- (comma-separated, empty = every role except referrer), party kind,
-- property roles, applicability, applicable-from stage, trailing financial
-- years, condition match, display order, notes.
--
-- Everything is written as text and cast in the SELECT, so a nullable column
-- needs no per-row cast and the table below stays readable as a table — the
-- same reasoning 0016 gives for writing the product catalogue this way.
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
  ('kyc_pan', 'PAN card — every individual signing', 'pan_card', 'party', 'applicant,co_applicant,guarantor', 'person', '', 'mandatory', 'documents_pending', '', 'all', '101', 'Universal. The one identity document no lender waives above small-ticket gold.'),
  ('kyc_aadhaar', 'Aadhaar card — every individual signing', 'aadhaar_card', 'party', 'applicant,co_applicant,guarantor', 'person', '', 'mandatory', 'documents_pending', '', 'all', '102', 'Serves as identity and address proof; used for e-KYC by most lenders.'),
  ('kyc_address_proof', 'Address proof — every individual signing', 'address_proof', 'party', 'applicant,co_applicant,guarantor', 'person', '', 'mandatory', 'documents_pending', '', 'all', '103', ''),
  ('kyc_photograph', 'Photograph — every individual signing', 'photograph', 'party', 'applicant,co_applicant,guarantor', 'person', '', 'mandatory', 'documents_pending', '', 'all', '104', ''),
  ('kyc_signature_proof', 'Signature proof', 'signature_proof', 'party', 'applicant,co_applicant,guarantor', 'person', '', 'optional', 'documents_pending', '', 'all', '105', 'Asked for by some lenders where the PAN signature is unclear.'),
  ('kyc_credit_bureau_consent', 'Credit bureau consent', 'credit_bureau_consent', 'party', 'applicant,co_applicant,guarantor', 'person', '', 'mandatory', 'documents_pending', '', 'all', '106', 'A bureau pull without written consent is not a shortcut, it is a breach.'),
  ('nri_passport', 'Passport — NRI applicant', 'passport', 'party', 'applicant,co_applicant,guarantor', 'person', '', 'mandatory', 'documents_pending', '', 'all', '207', ''),
  ('nri_visa', 'Visa or work permit — NRI applicant', 'visa', 'party', 'applicant,co_applicant,guarantor', 'person', '', 'mandatory', 'documents_pending', '', 'all', '208', ''),
  ('nri_overseas_income', 'Overseas income proof — NRI applicant', 'overseas_income_proof', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '', 'all', '209', 'Overseas payslips or an employment contract, usually attested.'),
  ('nri_power_of_attorney', 'Power of attorney — NRI applicant', 'power_of_attorney', 'party', 'applicant', 'person', '', 'mandatory', 'ready_for_submission', '', 'all', '210', 'A resident POA holder is how the lender gets documents executed in India.'),
  ('income_salary_slip', 'Salary slips — salaried', 'salary_slip', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '', 'all', '311', 'Last three months is the market norm; six for variable-pay profiles.'),
  ('income_form_16', 'Form 16 — salaried', 'form_16', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '2', 'all', '312', ''),
  ('income_salaried_banking', 'Bank statement — salary credit account', 'bank_statement', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '1', 'all', '313', 'Six months of the salary-credit account.'),
  ('income_employment_certificate', 'Employment certificate', 'employment_certificate', 'party', 'applicant,co_applicant', 'person', '', 'optional', 'documents_pending', '', 'all', '314', ''),
  ('income_appointment_letter', 'Appointment letter', 'appointment_letter', 'party', 'applicant,co_applicant', 'person', '', 'optional', 'documents_pending', '', 'all', '315', 'Asked for where employment vintage is short.'),
  ('income_itr', 'Income tax return — self-employed', 'itr', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '2', 'all', '316', 'Two assessment years with computation; the market standard.'),
  ('income_self_employed_banking', 'Bank statement — self-employed', 'bank_statement', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '1', 'all', '317', 'Twelve months, since there is no salary credit to read instead.'),
  ('income_qualification_proof', 'Qualification certificate — professional', 'qualification_proof', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '', 'all', '318', 'A professional loan is priced off the qualification; without it there is no product.'),
  ('income_practice_proof', 'Professional practice proof', 'professional_practice_proof', 'party', 'applicant,co_applicant', 'person', '', 'optional', 'documents_pending', '', 'all', '319', 'Practice vintage — registration, clinic licence, professional body membership.'),
  ('income_business_proof_individual', 'Business proof — business owner without a firm on the file', 'business_proof', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '', 'all', '320', 'A proprietor borrowing in their own name still has to evidence the business. Where the firm IS on the file, the firm''s own rules cover this instead.'),
  ('guarantor_itr', 'Income tax return — guarantor', 'itr', 'party', 'guarantor', 'person', '', 'optional', 'documents_pending', '1', 'all', '321', ''),
  ('guarantor_net_worth', 'Net worth statement — guarantor', 'net_worth_statement', 'party', 'guarantor', 'person', '', 'optional', 'documents_pending', '', 'all', '322', 'A guarantee is worth what the guarantor is worth.'),
  ('obligations_loan_statement', 'Existing loan statement', 'existing_loan_statement', 'party', 'applicant,co_applicant', '', '', 'mandatory', 'documents_pending', '', 'all', '423', 'Repayment track on every live facility — the obligations half of FOIR.'),
  ('takeover_loan_statement', 'Existing loan statement — takeover', 'existing_loan_statement', 'party', 'applicant', '', '', 'mandatory', 'documents_pending', '', 'all', '424', 'A balance transfer is entirely about the loan being transferred.'),
  ('takeover_foreclosure_letter', 'Foreclosure letter — takeover', 'foreclosure_letter', 'case', '', '', '', 'mandatory', 'ready_for_submission', '', 'all', '425', 'Dated and short-lived; asking for it on day two wastes it.'),
  ('firm_pan', 'Business PAN', 'org_pan', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '526', ''),
  ('firm_address_proof', 'Business address proof', 'org_address_proof', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '527', 'Utility bill or lease, dated within three months.'),
  ('firm_business_proof', 'Business registration proof', 'business_proof', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '528', 'Shop & Establishment, trade licence, or the constitution document itself.'),
  ('firm_bank_statement', 'Business bank statement', 'org_bank_statement', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '1', 'all', '529', 'Twelve months of the current account — the working-capital assessment.'),
  ('firm_itr', 'Business income tax return', 'org_itr', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '2', 'all', '530', ''),
  ('firm_balance_sheet', 'Balance sheet', 'balance_sheet', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '2', 'all', '531', ''),
  ('firm_profit_and_loss', 'Profit and loss statement', 'profit_and_loss', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '2', 'all', '532', ''),
  ('firm_audit_report', 'Audit report — audited constitutions', 'audit_report', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '2', 'all', '533', 'A proprietorship below the audit threshold has none, and is not asked.'),
  ('gst_certificate_firm', 'GST registration certificate', 'gst_certificate', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '534', ''),
  ('gst_returns_firm', 'GST returns', 'gst_returns', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '1', 'all', '535', 'GSTR-3B and GSTR-1 for the last financial year — the turnover the NBFC prices off.'),
  ('gst_certificate_individual', 'GST registration certificate — GST-registered individual borrower', 'gst_certificate', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '', 'all', '536', 'A GST-registered proprietor borrowing in their own name.'),
  ('constitution_partnership_deed', 'Partnership deed', 'partnership_deed', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '637', ''),
  ('constitution_llp_agreement', 'LLP agreement', 'llp_agreement', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '638', ''),
  ('constitution_incorporation', 'Certificate of incorporation', 'certificate_of_incorporation', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '639', ''),
  ('constitution_moa_aoa', 'MOA and AOA', 'moa_aoa', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '640', ''),
  ('constitution_board_resolution', 'Board resolution to borrow', 'board_resolution', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '641', 'A company borrows by resolution. Without it nobody on the file has authority.'),
  ('constitution_director_list', 'List of directors or partners', 'list_of_directors', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '642', ''),
  ('constitution_shareholding', 'Shareholding pattern', 'shareholding_pattern', 'party', 'borrower_firm', 'organisation', '', 'optional', 'documents_pending', '', 'all', '643', ''),
  ('constitution_trust_deed', 'Trust deed', 'trust_deed', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '644', ''),
  ('constitution_society_registration', 'Society registration certificate', 'society_registration', 'party', 'borrower_firm', 'organisation', '', 'optional', 'documents_pending', '', 'all', '645', ''),
  ('business_udyam_scheme', 'Udyam registration — scheme-linked products', 'udyam_certificate', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '746', 'CGTMSE and PMMY are only available to a registered MSME. No Udyam, no scheme.'),
  ('business_udyam_general', 'Udyam registration — other business products', 'udyam_certificate', 'case', '', '', '', 'optional', 'documents_pending', '', 'all', '747', ''),
  ('business_stock_statement', 'Stock and book debts statement', 'stock_statement', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '748', 'The security itself on a cash-credit limit — assessed, then monitored monthly.'),
  ('business_debtors_creditors', 'Debtors and creditors statement', 'debtors_creditors_statement', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '749', 'Ageing of receivables and payables — the working-capital cycle.'),
  ('business_project_report', 'Project report', 'project_report', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '750', 'A term loan funds a purpose. The report is that purpose, costed.'),
  ('business_machinery_quotation', 'Machinery quotation', 'machinery_quotation', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '751', ''),
  ('business_contract_or_tender', 'Contract or tender document', 'contract_or_tender', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '752', 'A bank guarantee is issued against an obligation. This is the obligation.'),
  ('business_invoices', 'Invoices or bills', 'invoice_bills', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '753', ''),
  ('business_buyer_acceptance', 'Buyer acceptance', 'buyer_acceptance', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '754', 'Discounting an invoice the buyer has not accepted is lending against hope.'),
  ('property_sale_deed', 'Sale deed / title deed', 'sale_deed', 'property', '', '', '', 'mandatory', 'documents_pending', '', 'all', '855', ''),
  ('property_parent_document', 'Parent document (title chain)', 'parent_document', 'property', '', '', '', 'mandatory', 'documents_pending', '', 'all', '856', 'Thirteen to thirty years of chain, depending on the lender''s legal panel.'),
  ('property_patta_chitta', 'Patta / Chitta', 'patta_chitta', 'property', '', '', '', 'mandatory', 'documents_pending', '', 'all', '857', 'Tamil Nadu revenue ownership record. An apartment on undivided share is the one common case where the patta sits with the land, not the buyer.'),
  ('property_encumbrance_certificate', 'Encumbrance certificate', 'encumbrance_cert', 'property', '', '', '', 'mandatory', 'documents_pending', '', 'all', '858', 'Villangam, from the Sub-Registrar. Thirteen years is the usual ask.'),
  ('property_tax_receipt', 'Property tax receipt', 'property_tax_receipt', 'property', '', '', '', 'mandatory', 'documents_pending', '', 'all', '859', ''),
  ('property_approved_plan', 'Approved building plan', 'approved_plan', 'property', '', '', '', 'mandatory', 'documents_pending', '', 'all', '860', ''),
  ('property_layout_approval', 'Layout approval (DTCP / CMDA / local body)', 'layout_approval', 'property', '', '', '', 'mandatory', 'documents_pending', '', 'all', '861', 'An unapproved layout is the most common reason a Tamil Nadu plot file is declined.'),
  ('property_sale_agreement', 'Sale agreement', 'sale_agreement', 'property', '', '', '', 'mandatory', 'documents_pending', '', 'all', '862', ''),
  ('property_builder_noc', 'Builder NOC / allotment letter', 'builder_noc', 'property', '', '', '', 'optional', 'documents_pending', '', 'all', '863', ''),
  ('property_occupancy_certificate', 'Occupancy certificate', 'occupancy_certificate', 'property', '', '', '', 'optional', 'documents_pending', '', 'all', '864', ''),
  ('property_legal_opinion', 'Legal opinion', 'legal_opinion', 'property', '', '', '', 'mandatory', 'ready_for_submission', '', 'all', '865', 'Produced by the lender''s panel advocate — not due before a lender is chosen.'),
  ('property_valuation_report', 'Valuation report', 'valuation_report', 'property', '', '', '', 'mandatory', 'ready_for_submission', '', 'all', '866', 'Demanding a valuation on day two, before a property is chosen, makes the checklist wrong and the progress bar useless (Requirements and Progress, Part 3).'),
  ('property_lease_deed', 'Registered lease deed — lease rental discounting', 'lease_deed', 'property', '', '', '', 'mandatory', 'documents_pending', '', 'all', '867', ''),
  ('property_tenant_kyc', 'Tenant KYC — lease rental discounting', 'tenant_kyc', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '868', 'LRD is underwritten on the tenant''s covenant, not the landlord''s income.'),
  ('construction_estimate', 'Construction estimate', 'construction_estimate', 'property', '', '', '', 'mandatory', 'documents_pending', '', 'all', '969', 'Costed by an engineer or architect. Drives the staged disbursement schedule.'),
  ('construction_progress_report', 'Construction progress report', 'construction_progress_report', 'property', '', '', '', 'mandatory', 'documents_pending', '', 'all', '970', 'Each further tranche is released against progress. Nothing to report before the first brick, so the requirement does not exist yet.'),
  ('vehicle_quotation', 'Vehicle quotation / proforma invoice', 'vehicle_quotation', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '1071', ''),
  ('vehicle_rc', 'Vehicle registration certificate — used vehicle', 'vehicle_rc', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '1072', ''),
  ('vehicle_valuation', 'Vehicle valuation — used vehicle', 'vehicle_valuation', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '1073', 'Tenure is capped by the vehicle''s age, so the valuation is also an eligibility input.'),
  ('vehicle_route_permit', 'Route permit — commercial vehicle', 'route_permit', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '1074', ''),
  ('vehicle_insurance', 'Vehicle insurance', 'vehicle_insurance', 'case', '', '', '', 'mandatory', 'ready_for_submission', '', 'all', '1075', ''),
  ('gold_appraisal_note', 'Gold appraisal note', 'gold_appraisal_note', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '1176', 'The appraiser''s weight, purity and valuation. The whole underwriting.'),
  ('education_admission_letter', 'Admission letter', 'admission_letter', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '1277', ''),
  ('education_fee_structure', 'Fee structure', 'fee_structure', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '1278', ''),
  ('education_academic_records', 'Academic records', 'academic_records', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '1279', ''),
  ('education_passport', 'Passport — overseas education', 'passport', 'party', 'applicant', 'person', '', 'mandatory', 'documents_pending', '', 'all', '1280', ''),
  ('education_visa', 'Visa — overseas education', 'visa', 'party', 'applicant', 'person', '', 'mandatory', 'ready_for_submission', '', 'all', '1281', 'Often granted after sanction. Due late, never treated as missing early.'),
  ('securities_demat_statement', 'Demat / portfolio statement', 'demat_statement', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '1382', ''),
  ('securities_fd_receipt', 'Fixed deposit receipt', 'fd_receipt', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '1383', ''),
  ('case_application_form', 'Application form', 'application_form', 'case', '', '', '', 'mandatory', 'documents_pending', '', 'all', '1484', ''),
  ('case_login_form', 'Login form', 'login_form', 'case', '', '', '', 'mandatory', 'ready_for_submission', '', 'all', '1485', 'The lender''s own form. Not fillable until the lender is chosen.'),
  ('case_nach_mandate', 'NACH mandate / security cheques', 'nach_mandate', 'case', '', '', '', 'mandatory', 'ready_for_submission', '', 'all', '1486', '')
) as v(code, name, document_type_code, scope, party_roles, party_kind,
       property_roles, applicability, stage, financial_years, condition_match,
       display_order, notes)
join document_type dt on dt.code = v.document_type_code
join requirement_applicability ra on ra.code = v.applicability
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Conditions. A rule with no row here is unconditional — PAN, for every
-- individual who signs.
--
-- Multiple values are pipe-separated so a value containing a comma stays one
-- value.
-- ---------------------------------------------------------------------------

insert into document_requirement_rule_condition (rule_id, fact, operator, values, display_order)
select
  r.id,
  v.fact,
  v.operator::app.rule_condition_operator,
  case when v.vals = '' then null else string_to_array(v.vals, '|') end,
  v.display_order::integer
from (values
  ('nri_passport', 'party.borrower_type', 'equals', 'nri_individual', '10'),
  ('nri_visa', 'party.borrower_type', 'equals', 'nri_individual', '10'),
  ('nri_overseas_income', 'party.borrower_type', 'equals', 'nri_individual', '10'),
  ('nri_power_of_attorney', 'party.borrower_type', 'equals', 'nri_individual', '10'),
  ('income_salary_slip', 'party.employment_type', 'in', 'salaried', '10'),
  ('income_salary_slip', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '20'),
  ('income_form_16', 'party.employment_type', 'in', 'salaried', '10'),
  ('income_form_16', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '20'),
  ('income_salaried_banking', 'party.employment_type', 'in', 'salaried', '10'),
  ('income_salaried_banking', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '20'),
  ('income_employment_certificate', 'party.employment_type', 'in', 'salaried', '10'),
  ('income_employment_certificate', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '20'),
  ('income_appointment_letter', 'party.employment_type', 'in', 'salaried', '10'),
  ('income_appointment_letter', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '20'),
  ('income_itr', 'party.employment_type', 'in', 'self_employed|business_owner', '10'),
  ('income_itr', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '20'),
  ('income_self_employed_banking', 'party.employment_type', 'in', 'self_employed|business_owner', '10'),
  ('income_self_employed_banking', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '20'),
  ('income_qualification_proof', 'case.product_code', 'in', 'pl_professional', '10'),
  ('income_practice_proof', 'party.employment_type', 'in', 'self_employed', '10'),
  ('income_practice_proof', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '20'),
  ('income_business_proof_individual', 'party.employment_type', 'in', 'business_owner', '10'),
  ('income_business_proof_individual', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('income_business_proof_individual', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '30'),
  ('obligations_loan_statement', 'party.has_existing_obligations', 'is_true', '', '10'),
  ('takeover_loan_statement', 'case.product_code', 'in', 'hl_balance_transfer|hl_top_up|lap_balance_transfer', '10'),
  ('takeover_foreclosure_letter', 'case.product_code', 'in', 'hl_balance_transfer|hl_top_up|lap_balance_transfer', '10'),
  ('firm_audit_report', 'party.business_constitution', 'in', 'llp|private_limited|public_limited', '10'),
  ('gst_certificate_firm', 'party.is_gst_registered', 'is_true', '', '10'),
  ('gst_returns_firm', 'party.is_gst_registered', 'is_true', '', '10'),
  ('gst_certificate_individual', 'case.is_gst_registered', 'is_true', '', '10'),
  ('gst_certificate_individual', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('gst_certificate_individual', 'party.employment_type', 'in', 'self_employed|business_owner', '30'),
  ('constitution_partnership_deed', 'party.business_constitution', 'in', 'partnership', '10'),
  ('constitution_llp_agreement', 'party.business_constitution', 'in', 'llp', '10'),
  ('constitution_incorporation', 'party.business_constitution', 'in', 'llp|private_limited|public_limited', '10'),
  ('constitution_moa_aoa', 'party.business_constitution', 'in', 'private_limited|public_limited', '10'),
  ('constitution_board_resolution', 'party.business_constitution', 'in', 'private_limited|public_limited|trust_society', '10'),
  ('constitution_director_list', 'party.business_constitution', 'in', 'partnership|llp|private_limited|public_limited', '10'),
  ('constitution_shareholding', 'party.business_constitution', 'in', 'private_limited|public_limited', '10'),
  ('constitution_trust_deed', 'party.business_constitution', 'in', 'trust_society', '10'),
  ('constitution_society_registration', 'party.business_constitution', 'in', 'trust_society', '10'),
  ('business_udyam_scheme', 'case.product_code', 'in', 'bl_msme_cgtmse|bl_mudra|bl_machinery', '10'),
  ('business_udyam_general', 'case.customer_product_code', 'in', 'business_loan', '10'),
  ('business_udyam_general', 'case.product_code', 'not_in', 'bl_msme_cgtmse|bl_mudra|bl_machinery', '20'),
  ('business_stock_statement', 'case.security_type_code', 'equals', 'stock_book_debts', '10'),
  ('business_debtors_creditors', 'case.product_code', 'in', 'bl_working_capital|bl_overdraft', '10'),
  ('business_project_report', 'case.product_code', 'in', 'bl_term_loan|bl_msme_cgtmse', '10'),
  ('business_machinery_quotation', 'case.product_code', 'in', 'bl_machinery', '10'),
  ('business_contract_or_tender', 'case.product_code', 'in', 'bl_non_fund_based', '10'),
  ('business_invoices', 'case.product_code', 'in', 'bl_bill_discounting', '10'),
  ('business_buyer_acceptance', 'case.product_code', 'in', 'bl_bill_discounting', '10'),
  ('property_patta_chitta', 'property.type', 'not_in', 'apartment', '10'),
  ('property_approved_plan', 'case.product_code', 'in', 'hl_self_construct|hl_plot_construction|hl_extension|hl_purchase', '10'),
  ('property_layout_approval', 'property.type', 'in', 'plot', '10'),
  ('property_layout_approval', 'case.product_code', 'in', 'hl_plot_purchase|hl_plot_construction', '20'),
  ('property_sale_agreement', 'case.product_code', 'in', 'hl_purchase|hl_plot_purchase|hl_plot_construction|hl_affordable|hl_nri', '10'),
  ('property_builder_noc', 'case.product_code', 'in', 'hl_purchase|hl_affordable', '10'),
  ('property_occupancy_certificate', 'case.product_code', 'in', 'hl_purchase|hl_affordable|hl_balance_transfer', '10'),
  ('property_lease_deed', 'case.product_code', 'in', 'lap_lrd', '10'),
  ('property_tenant_kyc', 'case.product_code', 'in', 'lap_lrd', '10'),
  ('construction_estimate', 'case.product_code', 'in', 'hl_self_construct|hl_plot_construction|hl_improvement|hl_extension', '10'),
  ('construction_progress_report', 'case.product_code', 'in', 'hl_self_construct|hl_plot_construction|hl_improvement|hl_extension', '10'),
  ('construction_progress_report', 'case.construction_stage', 'not_in', 'not_started', '20'),
  ('construction_progress_report', 'case.construction_stage', 'exists', '', '30'),
  ('vehicle_quotation', 'case.product_code', 'in', 'vl_new_car|vl_two_wheeler|vl_commercial_vehicle', '10'),
  ('vehicle_rc', 'case.product_code', 'in', 'vl_used_car', '10'),
  ('vehicle_valuation', 'case.product_code', 'in', 'vl_used_car', '10'),
  ('vehicle_route_permit', 'case.product_code', 'in', 'vl_commercial_vehicle', '10'),
  ('vehicle_insurance', 'case.customer_product_code', 'in', 'vehicle_loan', '10'),
  ('gold_appraisal_note', 'case.customer_product_code', 'in', 'gold_loan', '10'),
  ('education_admission_letter', 'case.customer_product_code', 'in', 'education_loan', '10'),
  ('education_fee_structure', 'case.customer_product_code', 'in', 'education_loan', '10'),
  ('education_academic_records', 'case.customer_product_code', 'in', 'education_loan', '10'),
  ('education_passport', 'case.product_code', 'in', 'el_abroad', '10'),
  ('education_visa', 'case.product_code', 'in', 'el_abroad', '10'),
  ('securities_demat_statement', 'case.product_code', 'in', 'las_shares_mf', '10'),
  ('securities_fd_receipt', 'case.product_code', 'in', 'las_fd', '10'),
  ('case_nach_mandate', 'case.customer_product_code', 'not_in', 'gold_loan', '10')
) as v(rule_code, fact, operator, vals, display_order)
join document_requirement_rule r on r.code = v.rule_code;

-- ---------------------------------------------------------------------------
-- Backfill: existing requirements are mandatory, which is what they were
-- before applicability existed as a concept.
-- ---------------------------------------------------------------------------

update document_requirement
set applicability_id = (select id from requirement_applicability where code = 'mandatory')
where applicability_id is null;
