/**
 * Every document type AOS knows how to ask for — in the words a telecaller
 * actually uses on the phone.
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
 * WHAT THE TELECALLER WORKFLOW MILESTONE CHANGED
 *
 * The first two passes named documents the way a credit manager names them.
 * "Credit Bureau Consent", "Application Form", "Parent Document (Title
 * Chain)", "Stock and Book Debts Statement" are all correct, and none of them
 * is a sentence anyone says to a customer in Coimbatore. A telecaller reading
 * a checklist out loud has to translate on the fly, and a translation done
 * live is a translation done differently every time.
 *
 * So each type now carries four things instead of two:
 *
 *   name         What we call it TO THE CUSTOMER. Plain, and where a form
 *                number is what makes it unambiguous, the form number is in
 *                the name — "GST Registration Certificate (GST REG-06)" is
 *                clearer than either half alone.
 *   localName    What it is called in Tamil Nadu when that differs — EC is
 *                "Villangam Certificate", Udyam was "Udyog Aadhaar", the
 *                bureau consent is "CIBIL Consent Form" everywhere in the
 *                trade. Shown as a quiet second line, never instead of the
 *                official name: the customer says one, the bank wants the
 *                other, and the telecaller needs both.
 *   description  One sentence a new joiner can read out. Where a document has
 *                common substitutes — address proof above all — the
 *                substitutes ARE the description, because "what counts as
 *                address proof?" is the single most-asked question on a
 *                collection call.
 *   category     Which block of the checklist it appears under. A flat list of
 *                forty rows is a list nobody reads; six labelled groups is a
 *                phone call with a shape.
 *
 * All of it remains master data: a business user may rename, deactivate or
 * add to any of it through the Master Data screen. This is the starting set,
 * not the permitted set.
 *
 * RESEARCH BASIS
 *
 * Naming was checked against how banks, NBFCs and DSAs in India — and
 * specifically in Tamil Nadu — actually publish and ask for these documents.
 * See the research note in Docs/Document Requirement Engine.md.
 */

/**
 * The six blocks a telecaller asks in.
 *
 * Ordered as a call runs: who you are, what you earn, what the business is,
 * what the books say, what the property is, and anything this one case needs
 * that the rules could not have known about.
 */
export const DOCUMENT_CATEGORIES = [
  "kyc",
  "income",
  "business",
  "financial",
  "property",
  "additional",
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

export const DOCUMENT_CATEGORY_LABELS: Record<DocumentCategory, string> = {
  kyc: "KYC Documents",
  income: "Income Documents",
  business: "Business Documents",
  financial: "Financial Documents",
  property: "Property Documents",
  additional: "Additional Documents",
};

/** One line under each group heading, so the grouping explains itself. */
export const DOCUMENT_CATEGORY_HINTS: Record<DocumentCategory, string> = {
  kyc: "Identity and address of everyone signing.",
  income: "What the customer earns, and how it is evidenced.",
  business: "Registration and standing of the business itself.",
  financial: "Returns, accounts and banking the lender reads.",
  property: "Title, revenue and approval papers for the property.",
  additional: "Loan paperwork and anything specific to this case.",
};

export interface DocumentTypeDefinition {
  readonly code: string;
  /** What we call it to the customer. */
  readonly name: string;
  /** What it is called locally, where that differs. Never a replacement. */
  readonly localName?: string;
  readonly ownerKind: "person" | "property" | "organisation" | "case";
  readonly requiresPeriod: boolean;
  readonly requiresExpiry: boolean;
  /** One sentence, readable out loud by someone in their first week. */
  readonly description: string;
  readonly category: DocumentCategory;
  readonly displayOrder: number;
}

/**
 * The eighteen types that existed before the rule engine (Database/migrations
 * /0009 and 0011).
 *
 * Their CODES are frozen — documents, requirements and storage paths all point
 * at them. Their names, descriptions and categories are not, and this
 * milestone rewrote every one of them into telecaller language.
 */
export const BASE_DOCUMENT_TYPES: readonly DocumentTypeDefinition[] = [
  {
    code: "pan_card",
    name: "PAN Card",
    ownerKind: "person",
    requiresPeriod: false,
    requiresExpiry: false,
    description: "The customer's own PAN card. Every lender asks for it and none of them waive it.",
    category: "kyc",
    displayOrder: 10,
  },
  {
    code: "aadhaar_card",
    name: "Aadhaar Card",
    ownerKind: "person",
    requiresPeriod: false,
    requiresExpiry: false,
    description: "Front and back. Serves as both identity and address proof for most lenders.",
    category: "kyc",
    displayOrder: 20,
  },
  {
    code: "address_proof",
    name: "Address Proof",
    ownerKind: "person",
    requiresPeriod: false,
    requiresExpiry: true,
    description:
      "Any one of: EB bill, gas bill, ration card, passport, driving licence or a rental " +
      "agreement — in the customer's name and not more than three months old.",
    category: "kyc",
    displayOrder: 30,
  },
  {
    code: "photograph",
    name: "Passport Size Photograph",
    ownerKind: "person",
    requiresPeriod: false,
    requiresExpiry: false,
    description: "One recent passport size photo. A clear phone photo of the print is enough to start.",
    category: "kyc",
    displayOrder: 40,
  },
  {
    code: "salary_slip",
    name: "Salary Slip",
    localName: "Payslip",
    ownerKind: "person",
    requiresPeriod: true,
    requiresExpiry: false,
    description: "Last three months' payslips. Six months where the salary includes incentive or overtime.",
    category: "income",
    displayOrder: 50,
  },
  {
    code: "form_16",
    name: "Form 16",
    ownerKind: "person",
    requiresPeriod: true,
    requiresExpiry: false,
    description: "The employer's annual salary and TDS certificate, one per financial year.",
    category: "income",
    displayOrder: 60,
  },
  {
    code: "bank_statement",
    name: "Bank Statement",
    ownerKind: "person",
    requiresPeriod: true,
    requiresExpiry: false,
    description:
      "Statement of the account the salary or business income comes into. " +
      "Six months for salaried, twelve for self-employed. A PDF from net banking is accepted.",
    category: "financial",
    displayOrder: 70,
  },
  {
    code: "itr",
    name: "Income Tax Return (ITR)",
    ownerKind: "person",
    requiresPeriod: true,
    requiresExpiry: false,
    description: "ITR with the computation sheet, one per assessment year. Usually the last two years.",
    category: "income",
    displayOrder: 80,
  },
  {
    code: "gst_certificate",
    name: "GST Registration Certificate (GST REG-06)",
    ownerKind: "organisation",
    requiresPeriod: false,
    requiresExpiry: false,
    description: "The certificate issued when the business registered for GST. It carries the GSTIN.",
    category: "business",
    displayOrder: 90,
  },
  {
    code: "gst_returns",
    name: "GST Returns (GSTR-3B)",
    ownerKind: "organisation",
    requiresPeriod: true,
    requiresExpiry: false,
    description:
      "The monthly GST return. Lenders read the last twelve months to see real turnover, " +
      "so ask for a full financial year at a time.",
    category: "business",
    displayOrder: 110,
  },
  {
    code: "balance_sheet",
    name: "Balance Sheet",
    ownerKind: "organisation",
    requiresPeriod: true,
    requiresExpiry: false,
    description: "The year-end statement of what the business owns and owes, signed by the auditor or CA.",
    category: "financial",
    displayOrder: 120,
  },
  {
    code: "profit_and_loss",
    name: "Profit & Loss Statement",
    localName: "P&L Account",
    ownerKind: "organisation",
    requiresPeriod: true,
    requiresExpiry: false,
    description: "The year's income and expenses, signed by the auditor or CA. Filed with the balance sheet.",
    category: "financial",
    displayOrder: 130,
  },
  {
    code: "sale_deed",
    name: "Sale Deed",
    localName: "Title Deed",
    ownerKind: "property",
    requiresPeriod: false,
    requiresExpiry: false,
    description: "The registered deed by which the current owner bought the property.",
    category: "property",
    displayOrder: 140,
  },
  {
    code: "encumbrance_cert",
    name: "Encumbrance Certificate",
    localName: "EC / Villangam",
    ownerKind: "property",
    requiresPeriod: true,
    requiresExpiry: false,
    description:
      "The Sub-Registrar's record of every sale and loan registered on the property. " +
      "Banks ask for the last thirteen years.",
    category: "property",
    displayOrder: 150,
  },
  {
    code: "approved_plan",
    name: "Building Approval Plan",
    localName: "Plan Approval",
    ownerKind: "property",
    requiresPeriod: false,
    requiresExpiry: false,
    description: "The building plan sanctioned by the panchayat, municipality, CMDA or DTCP.",
    category: "property",
    displayOrder: 160,
  },
  {
    code: "valuation_report",
    name: "Property Valuation Report",
    ownerKind: "property",
    requiresPeriod: false,
    requiresExpiry: true,
    description: "The bank's own valuer visits and values the property. Arranged after the bank is chosen.",
    category: "property",
    displayOrder: 170,
  },
  {
    code: "login_form",
    name: "Bank Login Form",
    ownerKind: "case",
    requiresPeriod: false,
    requiresExpiry: false,
    description: "The bank's own application form, signed. Only available once a bank has been chosen.",
    category: "additional",
    displayOrder: 180,
  },
  {
    code: "sanction_letter",
    name: "Sanction Letter",
    ownerKind: "case",
    requiresPeriod: false,
    requiresExpiry: true,
    description: "The bank's letter confirming the approved amount and terms.",
    category: "additional",
    displayOrder: 190,
  },
];

/**
 * Document types the rule engine introduced, plus the two the Telecaller
 * Workflow milestone added.
 *
 * Owner kind follows ADR-007 strictly: a document belongs to the person,
 * property or organisation it describes, and only genuinely case-specific
 * paperwork belongs to the case. A vehicle quotation is case-scoped because
 * AOS has no vehicle entity — noted here rather than silently modelled,
 * because "the case owns it" is a real answer only while that stays true.
 */
export const ENGINE_DOCUMENT_TYPES: readonly DocumentTypeDefinition[] = [
  // --- Individual KYC and identity -----------------------------------------
  { code: "signature_proof", name: "Signature Proof", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "A specimen signature on a blank sheet, asked for when the signature on the PAN is unclear.", category: "kyc", displayOrder: 200 },
  { code: "credit_bureau_consent", name: "Loan Consent Form", localName: "CIBIL Consent", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "The customer's signed permission to check their CIBIL score. We cannot check it without this.", category: "kyc", displayOrder: 210 },
  { code: "passport", name: "Passport", ownerKind: "person", requiresPeriod: false, requiresExpiry: true, description: "Photo page and address page. Needed for NRI customers and for study-abroad loans.", category: "kyc", displayOrder: 220 },
  { code: "visa", name: "Visa / Work Permit", ownerKind: "person", requiresPeriod: false, requiresExpiry: true, description: "The current visa or work permit page, for a customer living or studying abroad.", category: "kyc", displayOrder: 230 },
  { code: "power_of_attorney", name: "Power of Attorney (POA)", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "A registered POA given to a relative in India, so papers can be signed here while the customer is abroad.", category: "kyc", displayOrder: 240 },

  // --- Salaried income ------------------------------------------------------
  { code: "employment_certificate", name: "Employment Certificate", localName: "Job Certificate", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "A letter from the employer confirming the designation, how long they have worked there, and the salary.", category: "income", displayOrder: 250 },
  { code: "appointment_letter", name: "Appointment Letter", localName: "Offer Letter", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "The joining letter from the employer. Asked for when the customer has joined recently.", category: "income", displayOrder: 260 },

  // --- Self-employed and professional income --------------------------------
  { code: "qualification_proof", name: "Qualification Certificate", localName: "Degree Certificate", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "The degree or professional certificate — doctor, CA, engineer. A professional loan is given on the strength of it.", category: "income", displayOrder: 270 },
  { code: "professional_practice_proof", name: "Practice Proof", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Proof of how long they have practised — council registration, clinic licence or association membership.", category: "income", displayOrder: 280 },
  { code: "overseas_income_proof", name: "Overseas Income Proof", ownerKind: "person", requiresPeriod: true, requiresExpiry: false, description: "Foreign payslips or the employment contract for an NRI customer. Usually needs attestation.", category: "income", displayOrder: 290 },
  { code: "net_worth_statement", name: "Net Worth Statement", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "A CA's list of what the guarantor owns and owes. A guarantee is worth what the guarantor is worth.", category: "financial", displayOrder: 300 },

  // --- Existing obligations -------------------------------------------------
  { code: "existing_loan_statement", name: "Existing Loan Statement", localName: "Loan Account Statement", ownerKind: "person", requiresPeriod: true, requiresExpiry: false, description: "Statement of any loan the customer is already repaying, showing the EMI and how regularly it is paid.", category: "financial", displayOrder: 310 },
  { code: "foreclosure_letter", name: "Foreclosure Letter", localName: "Closure Quote", ownerKind: "person", requiresPeriod: false, requiresExpiry: true, description: "The existing bank's letter stating the exact amount needed to close the loan. It expires quickly, so ask for it late.", category: "financial", displayOrder: 320 },

  // --- The borrowing firm ---------------------------------------------------
  { code: "org_pan", name: "Business PAN Card", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The firm's own PAN card. A proprietorship uses the owner's personal PAN instead.", category: "business", displayOrder: 330 },
  { code: "org_address_proof", name: "Business Address Proof", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "EB bill, rental agreement or lease deed in the business's name, not more than three months old.", category: "business", displayOrder: 340 },
  { code: "business_proof", name: "Business Proof", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "Anything that shows the business is real and running — Shop & Establishment licence, trade licence, or the registration deed.", category: "business", displayOrder: 350 },
  { code: "udyam_certificate", name: "Udyam Registration Certificate", localName: "Udyog Aadhaar / MSME Certificate", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The MSME registration certificate. Compulsory for MUDRA and CGTMSE loans, and useful on every other business loan.", category: "business", displayOrder: 360 },
  { code: "org_itr", name: "Business ITR", ownerKind: "organisation", requiresPeriod: true, requiresExpiry: false, description: "The firm's own income tax return with computation, one per assessment year. Separate from the owner's personal ITR.", category: "business", displayOrder: 370 },
  { code: "org_bank_statement", name: "Business Bank Statement", localName: "Current Account Statement", ownerKind: "organisation", requiresPeriod: true, requiresExpiry: false, description: "Twelve months of the business current account. This is what the bank reads to judge daily turnover.", category: "financial", displayOrder: 380 },
  { code: "audit_report", name: "Audit Report", ownerKind: "organisation", requiresPeriod: true, requiresExpiry: false, description: "The auditor's report for the year. Companies and LLPs have one; a small proprietorship usually does not.", category: "financial", displayOrder: 390 },
  { code: "stock_statement", name: "Stock Statement", ownerKind: "organisation", requiresPeriod: true, requiresExpiry: false, description: "A list of stock in hand and money customers owe. This is the security on a cash credit limit.", category: "business", displayOrder: 400 },
  { code: "debtors_creditors_statement", name: "Debtors & Creditors List", ownerKind: "organisation", requiresPeriod: true, requiresExpiry: false, description: "Who owes the business money and whom it owes, with how long each has been outstanding.", category: "business", displayOrder: 410 },
  { code: "project_report", name: "Project Report", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "A written plan of what the loan will be spent on, with costs. Usually prepared by a CA.", category: "business", displayOrder: 420 },
  { code: "machinery_quotation", name: "Machinery Quotation", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The supplier's price quotation for the machine being bought.", category: "business", displayOrder: 430 },
  { code: "contract_or_tender", name: "Contract / Work Order", localName: "Tender Document", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The order or contract the bank guarantee or letter of credit is being taken for.", category: "business", displayOrder: 440 },
  { code: "invoice_bills", name: "Invoices / Bills", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The bills being discounted.", category: "business", displayOrder: 450 },
  { code: "buyer_acceptance", name: "Buyer Acceptance Letter", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The buyer's written confirmation that they accept the invoice and will pay it.", category: "business", displayOrder: 460 },

  // --- Constitution documents -----------------------------------------------
  { code: "partnership_deed", name: "Partnership Deed", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The registered deed naming the current partners and their shares.", category: "business", displayOrder: 470 },
  { code: "llp_agreement", name: "LLP Agreement", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The LLP's agreement as filed with the Registrar.", category: "business", displayOrder: 480 },
  { code: "certificate_of_incorporation", name: "Certificate of Incorporation", localName: "Company Registration Certificate", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The Registrar of Companies certificate issued when the company was formed.", category: "business", displayOrder: 490 },
  { code: "moa_aoa", name: "MOA & AOA", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The company's Memorandum and Articles of Association. These say whether the company is allowed to borrow.", category: "business", displayOrder: 500 },
  { code: "board_resolution", name: "Board Resolution", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The board's written decision to take this loan and who may sign for it.", category: "business", displayOrder: 510 },
  { code: "list_of_directors", name: "List of Directors / Partners", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The current directors or partners with their DIN, as filed.", category: "business", displayOrder: 520 },
  { code: "shareholding_pattern", name: "Shareholding Pattern", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "Who owns the company and what percentage each holds.", category: "business", displayOrder: 530 },
  { code: "trust_deed", name: "Trust Deed", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The deed that created the trust and states its borrowing powers.", category: "business", displayOrder: 540 },
  { code: "society_registration", name: "Society Registration Certificate", ownerKind: "organisation", requiresPeriod: false, requiresExpiry: false, description: "The society's registration certificate from the Registrar of Societies.", category: "business", displayOrder: 550 },

  // --- Property, with the Tamil Nadu core -----------------------------------
  { code: "sale_agreement", name: "Sale Agreement", localName: "Agreement to Sell", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "The written agreement with the seller, before registration. It fixes the price the loan is calculated on.", category: "property", displayOrder: 560 },
  { code: "parent_document", name: "Parent Documents", localName: "Previous Sale Deeds", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "The older sale deeds showing who owned the property before. Banks ask for thirteen to thirty years of them.", category: "property", displayOrder: 570 },
  { code: "patta_chitta", name: "Patta & Chitta", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "The Tamil Nadu land record. Patta shows who owns the land, Chitta shows what kind of land it is. Downloadable from the e-Services portal.", category: "property", displayOrder: 580 },
  { code: "property_tax_receipt", name: "Property Tax Receipt", localName: "House Tax Receipt", ownerKind: "property", requiresPeriod: true, requiresExpiry: false, description: "The latest paid tax receipt from the panchayat or corporation.", category: "property", displayOrder: 590 },
  { code: "layout_approval", name: "Layout Approval", localName: "DTCP / CMDA Approval", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "The approved layout for a plot, from DTCP, CMDA or the local body. An unapproved layout is the commonest reason a plot loan is refused.", category: "property", displayOrder: 600 },
  { code: "construction_estimate", name: "Construction Estimate", localName: "Engineer's Estimate", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "The engineer's or architect's costing of the building work. The bank releases money in stages against it.", category: "property", displayOrder: 610 },
  { code: "construction_progress_report", name: "Construction Progress Report", localName: "Stage Certificate", ownerKind: "property", requiresPeriod: true, requiresExpiry: false, description: "The engineer's certificate of how much of the building is finished. Each further release needs a fresh one.", category: "property", displayOrder: 620 },
  { code: "legal_opinion", name: "Legal Opinion", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "The bank's own lawyer checks the title and gives an opinion. Arranged after the bank is chosen.", category: "property", displayOrder: 630 },
  { code: "occupancy_certificate", name: "Occupancy Certificate", localName: "OC / Completion Certificate", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "The local body's certificate that the finished building may be lived in.", category: "property", displayOrder: 640 },
  { code: "builder_noc", name: "Builder NOC / Allotment Letter", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "The builder's no-objection letter and allotment letter, when buying from a builder.", category: "property", displayOrder: 650 },
  { code: "lease_deed", name: "Registered Lease Deed", ownerKind: "property", requiresPeriod: false, requiresExpiry: false, description: "The registered lease for the property whose rent is being lent against.", category: "property", displayOrder: 660 },

  // --- Vehicle. Case-scoped because AOS has no vehicle entity ---------------
  { code: "vehicle_quotation", name: "Vehicle Quotation", localName: "Proforma Invoice", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "The dealer's price quotation for the vehicle being bought.", category: "additional", displayOrder: 670 },
  { code: "vehicle_rc", name: "Vehicle RC Book", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "The RC of a second-hand vehicle. The bank's name is added to it after the loan is given.", category: "additional", displayOrder: 680 },
  { code: "vehicle_valuation", name: "Vehicle Valuation Report", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "A valuer's report on a second-hand vehicle. The vehicle's age limits how long the loan can run.", category: "additional", displayOrder: 690 },
  { code: "vehicle_insurance", name: "Vehicle Insurance", ownerKind: "case", requiresPeriod: false, requiresExpiry: true, description: "Full (comprehensive) insurance with the bank's name added on it.", category: "additional", displayOrder: 700 },
  { code: "route_permit", name: "Route Permit", ownerKind: "case", requiresPeriod: false, requiresExpiry: true, description: "The permit for a goods or passenger commercial vehicle.", category: "additional", displayOrder: 710 },

  // --- Gold, education, securities ------------------------------------------
  { code: "gold_appraisal_note", name: "Gold Appraisal Note", localName: "Appraiser's Slip", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "The appraiser's note of the weight, purity and value of the ornaments. On a gold loan this is the whole file.", category: "additional", displayOrder: 720 },
  { code: "admission_letter", name: "Admission Letter", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "The college's confirmed admission offer.", category: "additional", displayOrder: 730 },
  { code: "fee_structure", name: "Fee Structure", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "The college's fee schedule for the course. It decides how much can be sanctioned.", category: "additional", displayOrder: 740 },
  { code: "academic_records", name: "Academic Records", localName: "Marksheets", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "Marksheets and entrance exam results.", category: "additional", displayOrder: 750 },
  { code: "demat_statement", name: "Demat / Portfolio Statement", ownerKind: "person", requiresPeriod: true, requiresExpiry: false, description: "Statement of the shares or mutual funds being pledged, with today's value.", category: "financial", displayOrder: 760 },
  { code: "fd_receipt", name: "Fixed Deposit Receipt", localName: "FD Receipt", ownerKind: "person", requiresPeriod: false, requiresExpiry: false, description: "The deposit receipt being pledged for the loan.", category: "financial", displayOrder: 770 },

  // --- Case paperwork -------------------------------------------------------
  { code: "application_form", name: "Loan Application Form", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "Our own application form, filled and signed by the customer. Separate from the bank's login form.", category: "additional", displayOrder: 780 },
  { code: "nach_mandate", name: "NACH Mandate / Security Cheques", localName: "ECS Mandate", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "The signed EMI auto-debit mandate and any blank cheques the bank asks for.", category: "additional", displayOrder: 790 },
  { code: "tenant_kyc", name: "Tenant KYC", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "Identity and agreement papers of the tenant paying the rent, for a rent-based loan.", category: "additional", displayOrder: 800 },

  // --- Added by the Milestone 9.1 audit ------------------------------------
  { code: "form_26as", name: "Form 26AS / AIS", localName: "Tax Credit Statement", ownerKind: "person", requiresPeriod: true, requiresExpiry: false, description: "The income tax department's own record of income and TDS, downloaded from the income tax portal. Banks compare it against the ITR.", category: "income", displayOrder: 810 },
  { code: "own_contribution_proof", name: "Own Contribution Proof", localName: "Margin Money Proof", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "Proof the customer has paid their own share — the builder's or seller's receipt, or the bank transfer that paid it.", category: "financial", displayOrder: 820 },

  // --- Added by the Telecaller Workflow milestone ---------------------------
  /**
   * The home for a document a Login Executive adds by hand on one case
   * (Part 6). The requirement carries its own name and description; this type
   * exists so the upload, versioning and storage-path machinery has something
   * real to point at rather than a null.
   */
  { code: "other_document", name: "Other Document", ownerKind: "case", requiresPeriod: false, requiresExpiry: false, description: "A document asked for on this case only, added by hand because the standard list did not cover it.", category: "additional", displayOrder: 900 },
];

/** Every document type AOS knows about, base pack and engine pack together. */
export const ALL_DOCUMENT_TYPES: readonly DocumentTypeDefinition[] = [
  ...BASE_DOCUMENT_TYPES,
  ...ENGINE_DOCUMENT_TYPES,
];

/** Document type codes that existed before the rule engine (0009, 0011). */
export const PRE_ENGINE_DOCUMENT_TYPES: readonly string[] = BASE_DOCUMENT_TYPES.map(
  (type) => type.code,
);

/** Every document type code AOS knows about after this milestone. */
export function allDocumentTypeCodes(): string[] {
  return ALL_DOCUMENT_TYPES.map((type) => type.code);
}

export function documentTypeByCode(code: string): DocumentTypeDefinition | undefined {
  return ALL_DOCUMENT_TYPES.find((type) => type.code === code);
}

/** The code every hand-added, case-only requirement points at (Part 6). */
export const CUSTOM_DOCUMENT_TYPE_CODE = "other_document";
