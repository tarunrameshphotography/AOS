/**
 * Document types the rule engine introduced (Milestone 9, ADR-035).
 *
 * WHY THIS LIST LIVES IN src/domain/ AND NOT ONLY IN A SEED
 *
 * A rule names a `document_type.code`. A rule that names a type nobody
 * created is a rule that silently generates nothing — the worst possible
 * failure for a checklist, because it looks like the case simply does not
 * need the document. Defining the types the default pack depends on in the
 * same layer as the pack itself lets one test assert the two agree
 * (default-rules.test.ts), and lets the prototype seed and the SQL seed be
 * built from one source rather than kept in step by hand.
 *
 * These are ONLY the types the engine added. The eighteen that existed before
 * it (PAN, Aadhaar, salary slip, ITR, sale deed, ...) keep their existing
 * definitions in Database/migrations/0009 and 0011 and are untouched.
 *
 * All of it remains master data: a business user may rename, deactivate or
 * add to any of it through the Master Data screen. This is the starting set,
 * not the permitted set.
 */

export interface DocumentTypeDefinition {
  readonly code: string;
  readonly name: string;
  readonly ownerKind: "person" | "property" | "organisation" | "case";
  readonly requiresPeriod: boolean;
  readonly requiresExpiry: boolean;
  readonly description: string;
  readonly displayOrder: number;
}

/**
 * Owner kind follows ADR-007 strictly: a document belongs to the person,
 * property or organisation it describes, and only genuinely case-specific
 * paperwork belongs to the case. A vehicle quotation is case-scoped because
 * AOS has no vehicle entity — noted here rather than silently modelled,
 * because "the case owns it" is a real answer only while that stays true.
 */
export const ENGINE_DOCUMENT_TYPES: readonly DocumentTypeDefinition[] = [
  // --- Individual KYC and identity -----------------------------------------
  { code: "signature_proof", name: "Signature Proof", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Specimen signature, where the PAN signature is unclear.", displayOrder: 200 },
  { code: "credit_bureau_consent", name: "Credit Bureau Consent", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Written consent to pull a credit bureau report. A pull without it is not a shortcut, it is a breach.", displayOrder: 210 },
  { code: "passport", name: "Passport", ownerKind: "person", requiresPeriod: false, requiresExpiry: true, description: "Identity and, for NRI and overseas-education files, the residence evidence.", displayOrder: 220 },
  { code: "visa", name: "Visa / Work Permit", ownerKind: "person", requiresPeriod: false, requiresExpiry: true, description: "Current visa or work permit for an NRI borrower or an overseas student.", displayOrder: 230 },
  { code: "power_of_attorney", name: "Power of Attorney", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Registered POA, usually to a resident relative, so documents can be executed in India.", displayOrder: 240 },

  // --- Salaried income ------------------------------------------------------
  { code: "employment_certificate", name: "Employment Certificate", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Employer's confirmation of designation, tenure and salary.", displayOrder: 250 },
  { code: "appointment_letter", name: "Appointment Letter", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Asked for where employment vintage is short.", displayOrder: 260 },

  // --- Self-employed and professional income --------------------------------
  { code: "qualification_proof", name: "Qualification Certificate", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Degree or professional qualification. A professional loan is priced off it.", displayOrder: 270 },
  { code: "professional_practice_proof", name: "Professional Practice Proof", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Practice vintage — registration, clinic licence, professional body membership.", displayOrder: 280 },
  { code: "overseas_income_proof", name: "Overseas Income Proof", ownerKind: "person", requiresPeriod: true, requiresExpiry: false, description: "Overseas payslips or employment contract, usually attested, for an NRI borrower.", displayOrder: 290 },
  { code: "net_worth_statement", name: "Net Worth Statement", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Assets and liabilities, usually certified. A guarantee is worth what the guarantor is worth.", displayOrder: 300 },

  // --- Existing obligations -------------------------------------------------
  { code: "existing_loan_statement", name: "Existing Loan Statement", ownerKind: "person", requiresPeriod: true, requiresExpiry: false, description: "Repayment track on a live facility — the obligations half of FOIR.", displayOrder: 310 },
  { code: "foreclosure_letter", name: "Foreclosure Letter", ownerKind: "person", requiresPeriod: false, requiresExpiry: true, description: "The existing lender's payoff quote for a takeover. Dated and short-lived.", displayOrder: 320 },

  // --- The borrowing firm ---------------------------------------------------
  { code: "org_pan", name: "Business PAN Card", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The firm's own PAN. A proprietorship uses the proprietor's.", displayOrder: 330 },
  { code: "org_address_proof", name: "Business Address Proof", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "Utility bill or lease in the business's name, dated within three months.", displayOrder: 340 },
  { code: "business_proof", name: "Business Registration Proof", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "Shop & Establishment registration, trade licence, or the constitution document itself.", displayOrder: 350 },
  { code: "udyam_certificate", name: "Udyam Registration Certificate", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "MSME registration. Mandatory for CGTMSE and PMMY; useful evidence everywhere else.", displayOrder: 360 },
  { code: "org_itr", name: "Business Income Tax Return", ownerKind: "organisation", requiresPeriod: true, requiresExpiry: false, description: "Per financial year, with computation. Distinct from the proprietor's personal ITR.", displayOrder: 370 },
  { code: "org_bank_statement", name: "Business Bank Statement", ownerKind: "organisation", requiresPeriod: true, requiresExpiry: false, description: "Current account, twelve months. The working-capital assessment reads this.", displayOrder: 380 },
  { code: "audit_report", name: "Audit Report", ownerKind: "organisation", requiresPeriod: true, requiresExpiry: false, description: "Per financial year, for constitutions that are audited. A small proprietorship has none.", displayOrder: 390 },
  { code: "stock_statement", name: "Stock and Book Debts Statement", ownerKind: "organisation", requiresPeriod: true, requiresExpiry: false, description: "The security itself on a cash-credit limit — assessed at sanction, monitored monthly after.", displayOrder: 400 },
  { code: "debtors_creditors_statement", name: "Debtors and Creditors Statement", ownerKind: "organisation", requiresPeriod: true, requiresExpiry: false, description: "Ageing of receivables and payables — the working-capital cycle.", displayOrder: 410 },
  { code: "project_report", name: "Project Report", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "A term loan funds a purpose. This is that purpose, costed.", displayOrder: 420 },
  { code: "machinery_quotation", name: "Machinery Quotation", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "Supplier's quotation for the plant or equipment being financed.", displayOrder: 430 },
  { code: "contract_or_tender", name: "Contract or Tender Document", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The obligation a bank guarantee or letter of credit is issued against.", displayOrder: 440 },
  { code: "invoice_bills", name: "Invoices / Bills", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The invoices being discounted.", displayOrder: 450 },
  { code: "buyer_acceptance", name: "Buyer Acceptance", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The buyer's acceptance of the invoice. Discounting without it is lending against hope.", displayOrder: 460 },

  // --- Constitution documents -----------------------------------------------
  { code: "partnership_deed", name: "Partnership Deed", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "Registered deed with the current partners and their shares.", displayOrder: 470 },
  { code: "llp_agreement", name: "LLP Agreement", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The LLP's governing agreement, as filed.", displayOrder: 480 },
  { code: "certificate_of_incorporation", name: "Certificate of Incorporation", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "Registrar of Companies incorporation certificate.", displayOrder: 490 },
  { code: "moa_aoa", name: "MOA and AOA", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "Memorandum and Articles of Association. The borrowing powers live here.", displayOrder: 500 },
  { code: "board_resolution", name: "Board Resolution", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "A company borrows by resolution. Without it nobody on the file has authority to sign.", displayOrder: 510 },
  { code: "list_of_directors", name: "List of Directors / Partners", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "Current directors or partners with DIN, as filed.", displayOrder: 520 },
  { code: "shareholding_pattern", name: "Shareholding Pattern", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "Who owns the company, and in what proportion.", displayOrder: 530 },
  { code: "trust_deed", name: "Trust Deed", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The trust's constituting deed and its borrowing powers.", displayOrder: 540 },
  { code: "society_registration", name: "Society Registration Certificate", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "Registration under the relevant Societies Registration Act.", displayOrder: 550 },

  // --- Property, with the Tamil Nadu core -----------------------------------
  { code: "sale_agreement", name: "Sale Agreement", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "The agreement to sell, ahead of the deed. Fixes the consideration the funding ratio is applied to.", displayOrder: 560 },
  { code: "parent_document", name: "Parent Document (Title Chain)", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "Prior title deeds. Thirteen to thirty years of chain, depending on the lender's legal panel.", displayOrder: 570 },
  { code: "patta_chitta", name: "Patta / Chitta", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "Tamil Nadu revenue ownership record and land classification. Every TN legal opinion turns on it.", displayOrder: 580 },
  { code: "property_tax_receipt", name: "Property Tax Receipt", ownerKind: "property", requiresPeriod: true, requiresExpiry: false, description: "Latest paid receipt from the local body — evidence of possession as much as of payment.", displayOrder: 590 },
  { code: "layout_approval", name: "Layout Approval (DTCP / CMDA / Local Body)", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "Approved layout for a plot. An unapproved layout is the commonest reason a TN plot file is declined.", displayOrder: 600 },
  { code: "construction_estimate", name: "Construction Estimate", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "Costed by an engineer or architect. Drives the staged disbursement schedule.", displayOrder: 610 },
  { code: "construction_progress_report", name: "Construction Progress Report", ownerKind: "property", requiresPeriod: true, requiresExpiry: false, description: "Stage certificate against which each further tranche is released.", displayOrder: 620 },
  { code: "legal_opinion", name: "Legal Opinion", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "The lender's panel advocate's opinion on title. Not producible before a lender is chosen.", displayOrder: 630 },
  { code: "occupancy_certificate", name: "Occupancy Certificate", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "Local body's certificate that the completed building may be occupied.", displayOrder: 640 },
  { code: "builder_noc", name: "Builder NOC / Allotment Letter", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "Builder's no-objection and allotment, for a purchase from a developer.", displayOrder: 650 },
  { code: "lease_deed", name: "Registered Lease Deed", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "For lease rental discounting — the rent being lent against.", displayOrder: 660 },

  // --- Vehicle. Case-scoped because AOS has no vehicle entity ---------------
  { code: "vehicle_quotation", name: "Vehicle Quotation / Proforma Invoice", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "Dealer's quotation for the vehicle being financed.", displayOrder: 670 },
  { code: "vehicle_rc", name: "Vehicle Registration Certificate", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "RC of a used vehicle, with the hypothecation endorsement after disbursement.", displayOrder: 680 },
  { code: "vehicle_valuation", name: "Vehicle Valuation Report", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "Valuation of a used vehicle. Tenure is capped by the vehicle's age.", displayOrder: 690 },
  { code: "vehicle_insurance", name: "Vehicle Insurance", ownerKind: "case", requiresPeriod: false, requiresExpiry: true, description: "Comprehensive cover with the lender endorsed.", displayOrder: 700 },
  { code: "route_permit", name: "Route Permit", ownerKind: "case", requiresPeriod: false, requiresExpiry: true, description: "Permit for a goods or passenger commercial vehicle.", displayOrder: 710 },

  // --- Gold, education, securities ------------------------------------------
  { code: "gold_appraisal_note", name: "Gold Appraisal Note", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "The appraiser's weight, purity and valuation. On a gold loan this is the whole underwriting.", displayOrder: 720 },
  { code: "admission_letter", name: "Admission Letter", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Institution's confirmed admission offer.", displayOrder: 730 },
  { code: "fee_structure", name: "Fee Structure", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Institution's fee schedule for the course. Sets the sanction amount.", displayOrder: 740 },
  { code: "academic_records", name: "Academic Records", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Marksheets and entrance results.", displayOrder: 750 },
  { code: "demat_statement", name: "Demat / Portfolio Statement", ownerKind: "person", requiresPeriod: true, requiresExpiry: false, description: "Holdings being pledged, with current value.", displayOrder: 760 },
  { code: "fd_receipt", name: "Fixed Deposit Receipt", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "The deposit being lent against.", displayOrder: 770 },

  // --- Case paperwork -------------------------------------------------------
  { code: "application_form", name: "Application Form", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "Amaze's own signed application. Distinct from the lender's login form.", displayOrder: 780 },
  { code: "nach_mandate", name: "NACH Mandate / Security Cheques", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "Repayment mandate and any security cheques the lender takes.", displayOrder: 790 },
  { code: "tenant_kyc", name: "Tenant KYC", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "For lease rental discounting, which is underwritten on the tenant's covenant.", displayOrder: 800 },

  // --- Added by the Milestone 9.1 audit ------------------------------------
  // Two documents the first pass missed that every lender in this market
  // actually asks for. See the audit note in default-rules.ts.
  { code: "form_26as", name: "Form 26AS / AIS", ownerKind: "person", requiresPeriod: true, requiresExpiry: false, description: "The tax department's own record of income and TDS. Lenders read it against the ITR, because it is the one income document the borrower cannot author.", displayOrder: 810 },
  { code: "own_contribution_proof", name: "Own Contribution / Margin Money Proof", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "Evidence the borrower has paid their own share — builder's receipt (OCR), or the bank transfer that funded it. No sanction disburses without it.", displayOrder: 820 },
];

/** Document type codes that existed before the rule engine (0009, 0011). */
export const PRE_ENGINE_DOCUMENT_TYPES: readonly string[] = [
  "pan_card",
  "aadhaar_card",
  "address_proof",
  "photograph",
  "salary_slip",
  "form_16",
  "bank_statement",
  "itr",
  "gst_certificate",
  "gst_returns",
  "balance_sheet",
  "profit_and_loss",
  "sale_deed",
  "encumbrance_cert",
  "approved_plan",
  "valuation_report",
  "login_form",
  "sanction_letter",
];

/** Every document type code AOS knows about after this milestone. */
export function allDocumentTypeCodes(): string[] {
  return [...PRE_ENGINE_DOCUMENT_TYPES, ...ENGINE_DOCUMENT_TYPES.map((type) => type.code)];
}
