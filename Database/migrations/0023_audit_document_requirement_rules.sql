-- ===========================================================================
-- 0023 — Document Requirement Engine audit (Milestone 9.1)
--
-- Data only. Corrects the DEFAULT rule pack seeded by 0022 against how banks
-- and NBFCs lending in this market actually ask for paperwork. Every row here
-- remains editable by a business user afterwards; nothing is enforced by code.
--
-- GENERATED from src/domain/requirements/default-rules.ts and
-- document-catalogue.ts, which stay authoritative — same discipline as 0022.
-- Regenerate rather than edit by hand.
--
-- WHAT LIVE TESTING FOUND, AND WHAT THIS FIXES
--
--  1. GST NEVER APPEARED ON A BUSINESS LOAN. Every GST rule keyed off "is GST
--     registered" — a case fact that starts NULL and stays NULL until someone
--     is asked. Meanwhile lending_product.gst_requirement_id already says
--     `mandatory` on the eight business products and Commercial LAP (0016),
--     and the engine could already resolve `case.gst_requirement` — no rule
--     read it. Four new rules read it now.
--  2. A REGISTERED PROPRIETOR was asked for the GST certificate and never for
--     the returns: gst_certificate_individual had no counterpart.
--  3. BUSINESS FINANCIALS ONLY EXISTED FOR A SEPARATE FIRM. Balance sheet and
--     P&L were scoped to borrower_firm, so the ordinary MSME file — a
--     proprietor borrowing in their own name — was asked for a personal ITR
--     and nothing else.
--  4. FORM 26AS / AIS was missing entirely, though it is read against the ITR
--     on every self-employed file here.
--  5. OVER-ASKING ON GOLD. Bureau consent, guarantor documents and existing
--     loan statements all fired on gold loans, which are sanctioned at the
--     counter on the ornaments and assess no FOIR.
--
-- Plus: own contribution / margin money proof on purchase products, practice
-- proof raised to mandatory on the professional loan, and an LLP now asked
-- for the resolution authorising it to borrow.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Two document types the first pass missed.
-- ---------------------------------------------------------------------------

insert into document_type (code, name, owner_kind, requires_period, requires_expiry, description, display_order) values
  ('form_26as', 'Form 26AS / AIS', 'person', true, false, 'The tax department''s own record of income and TDS. Lenders read it against the ITR, because it is the one income document the borrower cannot author.', 810),
  ('own_contribution_proof', 'Own Contribution / Margin Money Proof', 'case', false, false, 'Evidence the borrower has paid their own share — builder''s receipt (OCR), or the bank transfer that funded it. No sanction disburses without it.', 820)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- New rules. Columns as in 0022: code, name, document type code, scope, party
-- roles, party kind, property roles, applicability, applicable-from stage,
-- trailing financial years, condition match, display order, notes.
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
  ('income_form_26as', 'Form 26AS / AIS — self-employed', 'form_26as', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '2', 'all', '318', 'Cross-checked against the ITR. A mismatch is the commonest reason a file stalls.'),
  ('income_form_26as_salaried', 'Form 26AS / AIS — salaried', 'form_26as', 'party', 'applicant,co_applicant', 'person', '', 'optional', 'documents_pending', '1', 'all', '319', 'Supporting, not primary — Form 16 already carries the employer''s TDS.'),
  ('income_balance_sheet_individual', 'Balance sheet — business borrower without a firm on the file', 'balance_sheet', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '2', 'all', '320', 'CA-certified, two years. Where the firm IS on the file, the firm''s own rule covers this.'),
  ('income_profit_and_loss_individual', 'Profit and loss — business borrower without a firm on the file', 'profit_and_loss', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '2', 'all', '321', ''),
  ('income_practice_proof_professional', 'Professional practice proof — professional loan', 'professional_practice_proof', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '', 'all', '324', 'Mandatory here, unlike the general optional rule above: a professional loan is priced off qualification AND vintage, so practice proof is the product, not a supporting document. The engine merges the two to the stricter reading.'),
  ('gst_returns_individual', 'GST returns — GST-registered individual borrower', 'gst_returns', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '1', 'all', '542', 'The audit found the certificate rule above had no returns counterpart, so a registered proprietor was asked to prove registration and never asked for the turnover the registration produces.'),
  ('gst_certificate_firm_by_product', 'GST registration certificate — product requires GST', 'gst_certificate', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '', 'all', '543', 'Asked because the product cannot be assessed without GST, not because anyone ticked a box.'),
  ('gst_returns_firm_by_product', 'GST returns — product requires GST', 'gst_returns', 'party', 'borrower_firm', 'organisation', '', 'mandatory', 'documents_pending', '1', 'all', '544', 'GSTR-3B and GSTR-1 for the last financial year — the turnover the NBFC prices off.'),
  ('gst_certificate_individual_by_product', 'GST registration certificate — product requires GST, no firm on the file', 'gst_certificate', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '', 'all', '545', 'The proprietor case: the business is the person, and the product still needs GST.'),
  ('gst_returns_individual_by_product', 'GST returns — product requires GST, no firm on the file', 'gst_returns', 'party', 'applicant,co_applicant', 'person', '', 'mandatory', 'documents_pending', '1', 'all', '546', ''),
  ('property_own_contribution', 'Own contribution / margin money proof', 'own_contribution_proof', 'case', '', '', '', 'mandatory', 'ready_for_submission', '', 'all', '875', 'The audit added this. Margin is 10–25% by ticket size and no lender disburses without evidence the borrower has paid theirs — a builder''s receipt, or the transfer that funded it. Due at submission, not on day two, because there is usually nothing to show until a property and a price exist.')
) as v(code, name, document_type_code, scope, party_roles, party_kind,
       property_roles, applicability, stage, financial_years, condition_match,
       display_order, notes)
join document_type dt on dt.code = v.document_type_code
join requirement_applicability ra on ra.code = v.applicability
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Conditions, for the new rules and for the five 0022 rules whose conditions
-- the audit changed.
--
-- The five are cleared first. Replacing rather than appending is what makes
-- this migration idempotent, and the five are named explicitly so that a rule
-- a business user has since edited is never touched.
-- ---------------------------------------------------------------------------

delete from document_requirement_rule_condition
where rule_id in (
  select id from document_requirement_rule
  where code in (
    'kyc_credit_bureau_consent',
    'guarantor_itr',
    'guarantor_net_worth',
    'obligations_loan_statement',
    'constitution_board_resolution'
  )
);

insert into document_requirement_rule_condition (rule_id, fact, operator, values, display_order)
select
  r.id,
  v.fact,
  v.operator::app.rule_condition_operator,
  case when v.vals = '' then null else string_to_array(v.vals, '|') end,
  v.display_order::integer
from (values
  ('kyc_credit_bureau_consent', 'case.customer_product_code', 'not_in', 'gold_loan', '10'),
  ('income_form_26as', 'party.employment_type', 'in', 'self_employed|business_owner', '10'),
  ('income_form_26as', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '20'),
  ('income_form_26as_salaried', 'party.employment_type', 'in', 'salaried', '10'),
  ('income_form_26as_salaried', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '20'),
  ('income_balance_sheet_individual', 'party.employment_type', 'in', 'self_employed|business_owner', '10'),
  ('income_balance_sheet_individual', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('income_balance_sheet_individual', 'case.customer_product_code', 'in', 'business_loan|lap|home_loan', '30'),
  ('income_profit_and_loss_individual', 'party.employment_type', 'in', 'self_employed|business_owner', '10'),
  ('income_profit_and_loss_individual', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('income_profit_and_loss_individual', 'case.customer_product_code', 'in', 'business_loan|lap|home_loan', '30'),
  ('income_practice_proof_professional', 'case.product_code', 'in', 'pl_professional', '10'),
  ('guarantor_itr', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '10'),
  ('guarantor_net_worth', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '10'),
  ('obligations_loan_statement', 'party.has_existing_obligations', 'is_true', '', '10'),
  ('obligations_loan_statement', 'case.customer_product_code', 'not_in', 'gold_loan|loan_against_securities', '20'),
  ('gst_returns_individual', 'case.is_gst_registered', 'is_true', '', '10'),
  ('gst_returns_individual', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('gst_returns_individual', 'party.employment_type', 'in', 'self_employed|business_owner', '30'),
  ('gst_certificate_firm_by_product', 'case.gst_requirement', 'equals', 'mandatory', '10'),
  ('gst_returns_firm_by_product', 'case.gst_requirement', 'equals', 'mandatory', '10'),
  ('gst_certificate_individual_by_product', 'case.gst_requirement', 'equals', 'mandatory', '10'),
  ('gst_certificate_individual_by_product', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('gst_certificate_individual_by_product', 'party.employment_type', 'in', 'self_employed|business_owner', '30'),
  ('gst_returns_individual_by_product', 'case.gst_requirement', 'equals', 'mandatory', '10'),
  ('gst_returns_individual_by_product', 'case.has_borrower_firm', 'is_false', '', '20'),
  ('gst_returns_individual_by_product', 'party.employment_type', 'in', 'self_employed|business_owner', '30'),
  ('constitution_board_resolution', 'party.business_constitution', 'in', 'private_limited|public_limited|trust_society|llp', '10'),
  ('property_own_contribution', 'case.product_code', 'in', 'hl_purchase|hl_plot_purchase|hl_plot_construction|hl_affordable|hl_nri', '10')
) as v(rule_code, fact, operator, vals, display_order)
join document_requirement_rule r on r.code = v.rule_code
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Notes for the five changed rules, so the "why am I being asked for this?"
-- panel explains the new behaviour rather than the old.
-- ---------------------------------------------------------------------------

update document_requirement_rule r
set notes = nullif(v.notes, '')
from (values
  ('kyc_credit_bureau_consent', 'A bureau pull without written consent is not a shortcut, it is a breach. Excluded on gold, which is underwritten on the ornaments and is routinely sanctioned at the counter without a bureau pull at all.'),
  ('guarantor_itr', ''),
  ('guarantor_net_worth', 'A guarantee is worth what the guarantor is worth.'),
  ('obligations_loan_statement', 'Repayment track on every live facility — the obligations half of FOIR. Gold and securities are not FOIR-assessed, so they do not ask.'),
  ('constitution_board_resolution', 'A company borrows by resolution. Without it nobody on the file has authority. The audit added LLP: designated partners resolve to borrow exactly as a board does, and the first pack asked an LLP for its agreement but never for the authority to sign. A partnership is deliberately absent — its deed names the authorised partners itself.')
) as v(code, notes)
where r.code = v.code;

-- ---------------------------------------------------------------------------
-- Display order resync.
--
-- The pack's order is declaration order in default-rules.ts, so inserting
-- eleven rules mid-file shifts every rule after them. Without this the SQL
-- seed and the prototype would render the same checklist in two different
-- orders — the drift 0022's header warns about.
-- ---------------------------------------------------------------------------

update document_requirement_rule r
set display_order = v.display_order
from (values
  ('kyc_pan', 101), ('kyc_aadhaar', 102), ('kyc_address_proof', 103),
  ('kyc_photograph', 104), ('kyc_signature_proof', 105), ('kyc_credit_bureau_consent', 106),
  ('nri_passport', 207), ('nri_visa', 208), ('nri_overseas_income', 209),
  ('nri_power_of_attorney', 210),
  ('income_salary_slip', 311), ('income_form_16', 312), ('income_salaried_banking', 313),
  ('income_employment_certificate', 314), ('income_appointment_letter', 315),
  ('income_itr', 316), ('income_self_employed_banking', 317),
  ('income_form_26as', 318), ('income_form_26as_salaried', 319),
  ('income_balance_sheet_individual', 320), ('income_profit_and_loss_individual', 321),
  ('income_qualification_proof', 322), ('income_practice_proof', 323),
  ('income_practice_proof_professional', 324), ('income_business_proof_individual', 325),
  ('guarantor_itr', 326), ('guarantor_net_worth', 327),
  ('obligations_loan_statement', 428), ('takeover_loan_statement', 429),
  ('takeover_foreclosure_letter', 430),
  ('firm_pan', 531), ('firm_address_proof', 532), ('firm_business_proof', 533),
  ('firm_bank_statement', 534), ('firm_itr', 535), ('firm_balance_sheet', 536),
  ('firm_profit_and_loss', 537), ('firm_audit_report', 538),
  ('gst_certificate_firm', 539), ('gst_returns_firm', 540),
  ('gst_certificate_individual', 541), ('gst_returns_individual', 542),
  ('gst_certificate_firm_by_product', 543), ('gst_returns_firm_by_product', 544),
  ('gst_certificate_individual_by_product', 545), ('gst_returns_individual_by_product', 546),
  ('constitution_partnership_deed', 647), ('constitution_llp_agreement', 648),
  ('constitution_incorporation', 649), ('constitution_moa_aoa', 650),
  ('constitution_board_resolution', 651), ('constitution_director_list', 652),
  ('constitution_shareholding', 653), ('constitution_trust_deed', 654),
  ('constitution_society_registration', 655),
  ('business_udyam_scheme', 756), ('business_udyam_general', 757),
  ('business_stock_statement', 758), ('business_debtors_creditors', 759),
  ('business_project_report', 760), ('business_machinery_quotation', 761),
  ('business_contract_or_tender', 762), ('business_invoices', 763),
  ('business_buyer_acceptance', 764),
  ('property_sale_deed', 865), ('property_parent_document', 866),
  ('property_patta_chitta', 867), ('property_encumbrance_certificate', 868),
  ('property_tax_receipt', 869), ('property_approved_plan', 870),
  ('property_layout_approval', 871), ('property_sale_agreement', 872),
  ('property_builder_noc', 873), ('property_occupancy_certificate', 874),
  ('property_own_contribution', 875), ('property_legal_opinion', 876),
  ('property_valuation_report', 877), ('property_lease_deed', 878),
  ('property_tenant_kyc', 879),
  ('construction_estimate', 980), ('construction_progress_report', 981),
  ('vehicle_quotation', 1082), ('vehicle_rc', 1083), ('vehicle_valuation', 1084),
  ('vehicle_route_permit', 1085), ('vehicle_insurance', 1086),
  ('gold_appraisal_note', 1187),
  ('education_admission_letter', 1288), ('education_fee_structure', 1289),
  ('education_academic_records', 1290), ('education_passport', 1291),
  ('education_visa', 1292),
  ('securities_demat_statement', 1393), ('securities_fd_receipt', 1394),
  ('case_application_form', 1495), ('case_login_form', 1496), ('case_nach_mandate', 1497)
) as v(code, display_order)
where r.code = v.code;
