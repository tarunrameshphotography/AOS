/**
 * Seed data for the prototype.
 *
 * Chosen to exercise the cases that break naive designs, not to look tidy:
 *
 *  - A repeat customer whose KYC is already on file (Principle #5).
 *  - A shared family phone across two people (ADR-013).
 *  - A case sanctioned at one bank and rejected at another (ADR-004).
 *  - A case on hold, and a case lost after sanction.
 *  - A joint application, and a business loan where the borrower is a firm.
 *  - A name with three spellings, so search has something to forgive.
 */

import { buildStoragePath, type DocumentOwner } from "@domain/storage/index.js";

import type { Database } from "./types.js";

const id = (prefix: string, n: number): string => `${prefix}_${String(n).padStart(3, "0")}`;

/** Seeded documents go through the same path builder a live upload would —
 * the seed is fake data, not a fake layout. */
function seedPath(owner: DocumentOwner, documentTypeCode: string, fileName: string): string {
  return buildStoragePath({ owner, documentTypeCode, version: 1, fileName });
}

/** Days ago, as an ISO string. Keeps the seed relative so it never looks stale. */
function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function daysAhead(days: number): string {
  return daysAgo(-days);
}

export function buildSeed(): Database {
  const people: Database["people"] = [
    {
      id: id("per", 1),
      fullName: "Ravi Kumar",
      dateOfBirth: "1986-04-12",
      locality: "Anna Nagar",
      city: "Madurai",
      aliases: ["R. Ravi", "Ravikumar"],
      identifiers: [
        { id: id("pid", 1), type: "phone", value: "+91 98431 20045", isPrimary: true, verificationSource: "self_declared" },
        { id: id("pid", 2), type: "pan", value: "ABCPK1234F", isPrimary: true, verificationSource: "seen_on_document" },
      ],
    },
    {
      id: id("per", 2),
      fullName: "Sasirekha M",
      dateOfBirth: "1990-09-02",
      locality: "Anna Nagar",
      city: "Madurai",
      // Three spellings of one person — the transliteration problem, seeded so
      // search has something real to forgive.
      aliases: ["Sasi Rekha", "Sashirekha", "Sasirekha Murugan"],
      identifiers: [
        // Same number as Ravi: the family phone. A bare phone match is Probable,
        // never Definite (ADR-013).
        { id: id("pid", 3), type: "phone", value: "+91 98431 20045", isPrimary: true, verificationSource: "self_declared" },
        { id: id("pid", 4), type: "pan", value: "DEFPS5678K", isPrimary: true, verificationSource: "seen_on_document" },
      ],
    },
    {
      id: id("per", 3),
      fullName: "Murugan S",
      locality: "K.K. Nagar",
      city: "Madurai",
      aliases: [],
      identifiers: [
        { id: id("pid", 5), type: "phone", value: "+91 94421 88310", isPrimary: true, verificationSource: "self_declared" },
      ],
    },
    {
      id: id("per", 4),
      fullName: "Deepa Krishnan",
      dateOfBirth: "1983-01-25",
      locality: "Villapuram",
      city: "Madurai",
      aliases: ["Deepa K"],
      identifiers: [
        { id: id("pid", 6), type: "phone", value: "+91 90031 44521", isPrimary: true, verificationSource: "self_declared" },
        { id: id("pid", 7), type: "pan", value: "GHIPD9012L", isPrimary: true, verificationSource: "verified_against_issuer" },
      ],
    },
    {
      id: id("per", 5),
      fullName: "Arun Prasad",
      locality: "Thirunagar",
      city: "Madurai",
      aliases: [],
      identifiers: [
        { id: id("pid", 8), type: "phone", value: "+91 99404 71122", isPrimary: true, verificationSource: "self_declared" },
      ],
    },
    // Staff
    { id: id("per", 90), fullName: "Priya Raman", aliases: [], identifiers: [] },
    { id: id("per", 91), fullName: "Karthik V", aliases: [], identifiers: [] },
    { id: id("per", 92), fullName: "Lakshmi Narayanan", aliases: [], identifiers: [] },
    { id: id("per", 93), fullName: "Suresh Babu", aliases: [], identifiers: [] },
    // A bank relationship manager — a person, like everyone else (ADR-006).
    { id: id("per", 94), fullName: "Vignesh R", aliases: [], identifiers: [
      { id: id("pid", 9), type: "phone", value: "+91 90252 66710", isPrimary: true, verificationSource: "self_declared" },
    ] },
  ];

  const organisations: Database["organisations"] = [
    { id: id("org", 1), canonicalName: "HDFC Bank", roles: ["lender"], city: "Mumbai", aliases: [] },
    { id: id("org", 2), canonicalName: "HDFC Bank — Madurai Main", roles: ["branch"], city: "Madurai", parentOrganisationId: id("org", 1), aliases: [] },
    // The alias ADR-009 and Identity Resolution Part 4 use as the running
    // example — "IIFL" / "IIFL Home Finance Ltd" / "India Infoline" is one
    // organisation, and search should find it through any of the three.
    { id: id("org", 3), canonicalName: "IIFL Home Finance Ltd", roles: ["lender"], city: "Mumbai", aliases: ["IIFL", "India Infoline"] },
    { id: id("org", 4), canonicalName: "IIFL — Madurai", roles: ["branch"], city: "Madurai", parentOrganisationId: id("org", 3), aliases: [] },
    { id: id("org", 5), canonicalName: "LIC Housing Finance", roles: ["lender"], city: "Mumbai", aliases: ["LIC HFL"] },
    { id: id("org", 6), canonicalName: "LIC HFL — Madurai", roles: ["branch"], city: "Madurai", parentOrganisationId: id("org", 5), aliases: [] },
    { id: id("org", 7), canonicalName: "Sundaram Finance", roles: ["lender"], city: "Chennai", aliases: [] },
    { id: id("org", 8), canonicalName: "Sundaram — Madurai", roles: ["branch"], city: "Madurai", parentOrganisationId: id("org", 7), aliases: [] },
    // Employers and a borrowing firm — same table, different flags (ADR-014).
    { id: id("org", 20), canonicalName: "ABC Textiles Pvt Ltd", roles: ["employer"], industry: "Textiles", city: "Madurai", aliases: ["ABC Textiles"] },
    { id: id("org", 21), canonicalName: "Meenakshi Mission Hospital", roles: ["employer"], industry: "Healthcare", city: "Madurai", aliases: [] },
    { id: id("org", 22), canonicalName: "Sri Lakshmi Traders", roles: ["employer", "borrower"], industry: "Wholesale", city: "Madurai", aliases: [] },
    { id: id("org", 23), canonicalName: "Vaigai Constructions", roles: ["builder", "developer"], industry: "Construction", city: "Madurai", aliases: [] },
  ];

  const employments: Database["employments"] = [
    { id: id("emp", 1), personId: id("per", 1), organisationId: id("org", 20), designation: "Production Supervisor", monthlyIncome: 48000, employmentType: "salaried", isCurrent: true },
    { id: id("emp", 2), personId: id("per", 2), organisationId: id("org", 21), designation: "Staff Nurse", monthlyIncome: 32000, employmentType: "salaried", isCurrent: true },
    { id: id("emp", 3), personId: id("per", 4), organisationId: id("org", 22), designation: "Proprietor", monthlyIncome: 145000, employmentType: "business_owner", isCurrent: true },
    { id: id("emp", 4), personId: id("per", 5), organisationId: id("org", 20), designation: "Accounts Executive", monthlyIncome: 27000, employmentType: "salaried", isCurrent: true },
  ];

  const properties: Database["properties"] = [
    { id: id("prp", 1), buildingName: "Green Meadows", doorNumber: "3B", locality: "Anna Nagar", city: "Madurai", propertyType: "Apartment", estimatedValue: 5200000 },
    { id: id("prp", 2), doorNumber: "12/4", locality: "Thirunagar", city: "Madurai", propertyType: "Independent House", estimatedValue: 3800000 },
    { id: id("prp", 3), locality: "Othakadai", city: "Madurai", propertyType: "Plot", estimatedValue: 2100000 },
  ];

  const users: Database["users"] = [
    { id: id("usr", 1), personId: id("per", 90), name: "Priya Raman", roles: ["telecaller"], isActive: true },
    { id: id("usr", 2), personId: id("per", 91), name: "Karthik V", roles: ["login_executive"], isActive: true },
    { id: id("usr", 3), personId: id("per", 92), name: "Lakshmi Narayanan", roles: ["manager"], isActive: true },
    { id: id("usr", 4), personId: id("per", 93), name: "Suresh Babu", roles: ["finance"], isActive: true },
    // One human, two hats — the case ADR-022 exists for.
    { id: id("usr", 5), personId: id("per", 91), name: "Karthik V (also calling)", roles: ["telecaller", "login_executive"], isActive: true },
  ];

  const loanProducts: Database["loanProducts"] = [
    { id: id("lpr", 1), code: "hl_purchase", category: "Home Loan", variant: "Purchase" },
    { id: id("lpr", 2), code: "hl_self_construct", category: "Home Loan", variant: "Self Construction" },
    { id: id("lpr", 3), code: "hl_plot_purchase", category: "Home Loan", variant: "Plot Purchase" },
    { id: id("lpr", 4), code: "hl_balance_transfer", category: "Home Loan", variant: "Balance Transfer" },
    { id: id("lpr", 5), code: "hl_top_up", category: "Home Loan", variant: "Top-up" },
    { id: id("lpr", 6), code: "bl_working_capital", category: "Business Loan", variant: "Working Capital" },
    { id: id("lpr", 7), code: "bl_term_loan", category: "Business Loan", variant: "Term Loan" },
    { id: id("lpr", 8), code: "lap", category: "LAP", variant: "Loan Against Property" },
    { id: id("lpr", 9), code: "pl", category: "Personal", variant: "Personal Loan" },
  ];

  const documentTypes: Database["documentTypes"] = [
    { id: id("dty", 1), code: "pan_card", name: "PAN Card", ownerKind: "person", requiresPeriod: false },
    { id: id("dty", 2), code: "aadhaar_card", name: "Aadhaar Card", ownerKind: "person", requiresPeriod: false },
    { id: id("dty", 3), code: "address_proof", name: "Address Proof", ownerKind: "person", requiresPeriod: false },
    { id: id("dty", 4), code: "photograph", name: "Photograph", ownerKind: "person", requiresPeriod: false },
    { id: id("dty", 5), code: "salary_slip", name: "Salary Slip", ownerKind: "person", requiresPeriod: true },
    { id: id("dty", 6), code: "form_16", name: "Form 16", ownerKind: "person", requiresPeriod: true },
    { id: id("dty", 7), code: "bank_statement", name: "Bank Statement", ownerKind: "person", requiresPeriod: true },
    { id: id("dty", 8), code: "itr", name: "Income Tax Return", ownerKind: "person", requiresPeriod: true },
    { id: id("dty", 9), code: "gst_certificate", name: "GST Certificate", ownerKind: "organisation", requiresPeriod: false },
    // financial_statements is retained (not deleted, per BR-027's pattern) but
    // no longer generated — superseded by the two split-out, financial-year-
    // scoped types below (Database/migrations/0011).
    { id: id("dty", 10), code: "financial_statements", name: "Financial Statements", ownerKind: "organisation", requiresPeriod: true },
    { id: id("dty", 17), code: "gst_returns", name: "GST Returns", ownerKind: "organisation", requiresPeriod: true },
    { id: id("dty", 18), code: "balance_sheet", name: "Balance Sheet", ownerKind: "organisation", requiresPeriod: true },
    { id: id("dty", 19), code: "profit_and_loss", name: "Profit and Loss Statement", ownerKind: "organisation", requiresPeriod: true },
    { id: id("dty", 11), code: "sale_deed", name: "Sale Deed", ownerKind: "property", requiresPeriod: false },
    { id: id("dty", 12), code: "encumbrance_cert", name: "Encumbrance Certificate", ownerKind: "property", requiresPeriod: true },
    { id: id("dty", 13), code: "approved_plan", name: "Approved Building Plan", ownerKind: "property", requiresPeriod: false },
    { id: id("dty", 14), code: "valuation_report", name: "Valuation Report", ownerKind: "property", requiresPeriod: false },
    { id: id("dty", 15), code: "login_form", name: "Login Form", ownerKind: "case", requiresPeriod: false },
    { id: id("dty", 16), code: "sanction_letter", name: "Sanction Letter", ownerKind: "case", requiresPeriod: false },
  ];

  const rejectionReasons: Database["rejectionReasons"] = [
    { id: id("rej", 1), code: "credit_history", name: "Credit history", displayOrder: 10 },
    { id: id("rej", 2), code: "income_insufficient", name: "Income insufficient", displayOrder: 20 },
    { id: id("rej", 3), code: "obligations_too_high", name: "Existing obligations too high", displayOrder: 30 },
    { id: id("rej", 4), code: "vintage_insufficient", name: "Employment or business vintage insufficient", displayOrder: 40 },
    { id: id("rej", 5), code: "documents_incomplete", name: "Documents incomplete", displayOrder: 50 },
    { id: id("rej", 6), code: "document_discrepancy", name: "Document discrepancy", displayOrder: 60 },
    { id: id("rej", 7), code: "banking_unsatisfactory", name: "Banking conduct unsatisfactory", displayOrder: 70 },
    { id: id("rej", 8), code: "property_legal", name: "Property — legal or title issue", displayOrder: 80 },
    { id: id("rej", 9), code: "property_technical", name: "Property — technical or valuation issue", displayOrder: 90 },
    { id: id("rej", 10), code: "age_tenure_mismatch", name: "Age or tenure mismatch", displayOrder: 100 },
    { id: id("rej", 11), code: "profile_or_area_policy", name: "Profile or area policy", displayOrder: 110 },
    { id: id("rej", 12), code: "product_not_offered", name: "Product not offered", displayOrder: 120 },
  ];

  const year = new Date().getFullYear();
  const num = (n: number): string => `AL-${year}-${String(n).padStart(5, "0")}`;

  const cases: Database["cases"] = [
    {
      id: id("cas", 1), caseNumber: num(41), loanProductId: id("lpr", 1), requestedAmount: 3500000,
      stage: "sanctioned", ownerUserId: id("usr", 1), source: "Referral",
      isOnHold: false, isInvoiceRaised: false, tags: ["builder tie-up"], createdAt: daysAgo(62),
    },
    {
      id: id("cas", 2), caseNumber: num(42), loanProductId: id("lpr", 2), requestedAmount: 1800000,
      stage: "documents_pending", ownerUserId: id("usr", 1), source: "Walk-in",
      isOnHold: false, isInvoiceRaised: false, tags: [], createdAt: daysAgo(11),
    },
    {
      id: id("cas", 3), caseNumber: num(43), loanProductId: id("lpr", 6), requestedAmount: 5000000,
      stage: "submitted", ownerUserId: id("usr", 2), source: "Referral",
      isOnHold: false, isInvoiceRaised: false, tags: ["urgent"], createdAt: daysAgo(28),
    },
    {
      id: id("cas", 4), caseNumber: num(44), loanProductId: id("lpr", 1), requestedAmount: 2600000,
      stage: "documents_pending", ownerUserId: id("usr", 1), source: "Phone enquiry",
      // On hold: the customer is travelling. Still at documents_pending, which is
      // where it resumes — a hold is not a stage (ADR-021).
      isOnHold: true, holdReason: "Customer travelling until month end", holdUntil: daysAhead(9),
      isInvoiceRaised: false, tags: [], createdAt: daysAgo(19),
    },
    {
      id: id("cas", 5), caseNumber: num(45), loanProductId: id("lpr", 9), requestedAmount: 400000,
      stage: "new", ownerUserId: id("usr", 1), source: "Phone enquiry",
      isOnHold: false, isInvoiceRaised: false, tags: [], createdAt: daysAgo(1),
    },
    {
      id: id("cas", 6), caseNumber: num(46), loanProductId: id("lpr", 1), requestedAmount: 4200000,
      // Lost after sanction, over rate. Among the most commercially useful things
      // the company can record.
      stage: "lost", ownerUserId: id("usr", 1), lostReason: "rate_too_high",
      lostNote: "Competitor offered 8.4% against our 8.95%.", stageBeforeLost: "sanctioned",
      isOnHold: false, isInvoiceRaised: false, tags: [], createdAt: daysAgo(95),
    },
    {
      id: id("cas", 7), caseNumber: num(47), loanProductId: id("lpr", 5), requestedAmount: 900000,
      // The repeat customer: Ravi again, KYC already on file.
      stage: "contacted", ownerUserId: id("usr", 1), source: "Repeat customer",
      isOnHold: false, isInvoiceRaised: false, tags: [], createdAt: daysAgo(3),
    },
    {
      id: id("cas", 8), caseNumber: num(40), loanProductId: id("lpr", 1), requestedAmount: 2900000,
      stage: "disbursed", ownerUserId: id("usr", 2), source: "Referral",
      isOnHold: false, isInvoiceRaised: false, tags: [], createdAt: daysAgo(140),
    },
  ];

  const caseParties: Database["caseParties"] = [
    // 1 — joint application, with a referrer
    { id: id("cpt", 1), caseId: id("cas", 1), personId: id("per", 1), role: "applicant", isPrimary: true },
    { id: id("cpt", 2), caseId: id("cas", 1), personId: id("per", 2), role: "co_applicant", isPrimary: false },
    { id: id("cpt", 3), caseId: id("cas", 1), personId: id("per", 3), role: "referrer", isPrimary: false },
    // 2 — the simple case: one applicant and nothing else
    { id: id("cpt", 4), caseId: id("cas", 2), personId: id("per", 5), role: "applicant", isPrimary: true },
    // 3 — business loan: the borrower is a firm
    { id: id("cpt", 5), caseId: id("cas", 3), personId: id("per", 4), role: "applicant", isPrimary: true },
    { id: id("cpt", 6), caseId: id("cas", 3), organisationId: id("org", 22), role: "borrower_firm", isPrimary: false },
    { id: id("cpt", 7), caseId: id("cas", 4), personId: id("per", 2), role: "applicant", isPrimary: true },
    { id: id("cpt", 8), caseId: id("cas", 5), personId: id("per", 3), role: "applicant", isPrimary: true },
    { id: id("cpt", 9), caseId: id("cas", 6), personId: id("per", 4), role: "applicant", isPrimary: true },
    { id: id("cpt", 10), caseId: id("cas", 7), personId: id("per", 1), role: "applicant", isPrimary: true },
    { id: id("cpt", 11), caseId: id("cas", 8), personId: id("per", 1), role: "applicant", isPrimary: true },
  ];

  const caseProperties: Database["caseProperties"] = [
    { id: id("cpr", 1), caseId: id("cas", 1), propertyId: id("prp", 1), role: "purchase" },
    { id: id("cpr", 2), caseId: id("cas", 2), propertyId: id("prp", 2), role: "collateral" },
    { id: id("cpr", 3), caseId: id("cas", 8), propertyId: id("prp", 1), role: "purchase" },
  ];

  // Ravi's KYC, already on file. Case 7 opens with it satisfied — the visible win
  // that "information is entered once" is supposed to produce.
  const documents: Database["documents"] = [
    { id: id("doc", 1), documentTypeId: id("dty", 1), ownerKind: "person", personId: id("per", 1), filePath: seedPath({ kind: "person", id: id("per", 1) }, "pan_card", "ravi-pan.pdf"), version: 1, fileName: "ravi-pan.pdf", fileSizeBytes: 184320, uploadedAt: daysAgo(138), uploadedBy: id("usr", 2), verifiedAt: daysAgo(137), verifiedBy: id("usr", 2) },
    { id: id("doc", 2), documentTypeId: id("dty", 2), ownerKind: "person", personId: id("per", 1), filePath: seedPath({ kind: "person", id: id("per", 1) }, "aadhaar_card", "ravi-aadhaar-masked.pdf"), version: 1, fileName: "ravi-aadhaar-masked.pdf", fileSizeBytes: 210944, uploadedAt: daysAgo(138), uploadedBy: id("usr", 2), verifiedAt: daysAgo(137), verifiedBy: id("usr", 2) },
    { id: id("doc", 3), documentTypeId: id("dty", 3), ownerKind: "person", personId: id("per", 1), filePath: seedPath({ kind: "person", id: id("per", 1) }, "address_proof", "ravi-eb-bill.pdf"), version: 1, fileName: "ravi-eb-bill.pdf", fileSizeBytes: 96256, uploadedAt: daysAgo(138), uploadedBy: id("usr", 2), verifiedAt: daysAgo(136), verifiedBy: id("usr", 2) },
    { id: id("doc", 4), documentTypeId: id("dty", 5), ownerKind: "person", personId: id("per", 1), filePath: seedPath({ kind: "person", id: id("per", 1) }, "salary_slip", "ravi-payslips-q1.pdf"), version: 1, fileName: "ravi-payslips-q1.pdf", fileSizeBytes: 331776, uploadedAt: daysAgo(60), uploadedBy: id("usr", 2), verifiedAt: daysAgo(59), verifiedBy: id("usr", 2) },
    { id: id("doc", 5), documentTypeId: id("dty", 7), ownerKind: "person", personId: id("per", 1), filePath: seedPath({ kind: "person", id: id("per", 1) }, "bank_statement", "ravi-hdfc-6mo.pdf"), version: 1, fileName: "ravi-hdfc-6mo.pdf", fileSizeBytes: 542720, uploadedAt: daysAgo(60), uploadedBy: id("usr", 2), verifiedAt: daysAgo(59), verifiedBy: id("usr", 2) },
    { id: id("doc", 6), documentTypeId: id("dty", 1), ownerKind: "person", personId: id("per", 2), filePath: seedPath({ kind: "person", id: id("per", 2) }, "pan_card", "sasirekha-pan.pdf"), version: 1, fileName: "sasirekha-pan.pdf", fileSizeBytes: 176128, uploadedAt: daysAgo(58), uploadedBy: id("usr", 2), verifiedAt: daysAgo(57), verifiedBy: id("usr", 2) },
    { id: id("doc", 7), documentTypeId: id("dty", 11), ownerKind: "property", propertyId: id("prp", 1), filePath: seedPath({ kind: "property", id: id("prp", 1) }, "sale_deed", "green-meadows-sale-deed.pdf"), version: 1, fileName: "green-meadows-sale-deed.pdf", fileSizeBytes: 1458176, uploadedAt: daysAgo(55), uploadedBy: id("usr", 2), verifiedAt: daysAgo(54), verifiedBy: id("usr", 2) },
    // Received but not yet verified — feeds the login desk's queue.
    { id: id("doc", 8), documentTypeId: id("dty", 1), ownerKind: "person", personId: id("per", 5), filePath: seedPath({ kind: "person", id: id("per", 5) }, "pan_card", "arun-pan.jpg"), version: 1, fileName: "arun-pan.jpg", fileSizeBytes: 88064, uploadedAt: daysAgo(2), uploadedBy: id("usr", 1) },
  ];

  const submissions: Database["submissions"] = [
    // Case 1: sanctioned at one bank, rejected at another. Both true at once.
    { id: id("sub", 1), caseId: id("cas", 1), branchOrganisationId: id("org", 2), status: "sanctioned", submittedAt: daysAgo(38), loginFeeAmount: 5900, bankReferenceNumber: "HDFC/MDU/2026/8841", createdAt: daysAgo(40) },
    { id: id("sub", 2), caseId: id("cas", 1), branchOrganisationId: id("org", 4), status: "rejected", submittedAt: daysAgo(37), rejectionReasonId: id("rej", 3), bankReasonText: "FOIR exceeds 55% post proposed EMI", createdAt: daysAgo(39) },
    { id: id("sub", 3), caseId: id("cas", 1), branchOrganisationId: id("org", 6), status: "under_process", submittedAt: daysAgo(20), createdAt: daysAgo(21) },
    // Case 3
    { id: id("sub", 4), caseId: id("cas", 3), branchOrganisationId: id("org", 8), status: "query_raised", submittedAt: daysAgo(14), createdAt: daysAgo(15) },
    // Case 8 — disbursed
    { id: id("sub", 5), caseId: id("cas", 8), branchOrganisationId: id("org", 2), status: "disbursed", submittedAt: daysAgo(120), loginFeeAmount: 5900, createdAt: daysAgo(122) },
    // Case 6 — lost after sanction
    { id: id("sub", 6), caseId: id("cas", 6), branchOrganisationId: id("org", 2), status: "sanctioned", submittedAt: daysAgo(80), createdAt: daysAgo(82) },
  ];

  const offers: Database["offers"] = [
    { id: id("off", 1), submissionId: id("sub", 1), sanctionedAmount: 3400000, interestRate: 8.95, tenureMonths: 240, processingFee: 11800, validUntil: daysAhead(12), isAccepted: false },
    { id: id("off", 2), submissionId: id("sub", 5), sanctionedAmount: 2900000, interestRate: 8.7, tenureMonths: 240, processingFee: 10620, isAccepted: true },
    { id: id("off", 3), submissionId: id("sub", 6), sanctionedAmount: 4100000, interestRate: 8.95, tenureMonths: 240, validUntil: daysAgo(30), isAccepted: false },
  ];

  const communications: Database["communications"] = [
    { id: id("com", 1), caseId: id("cas", 1), personId: id("per", 1), channel: "call", direction: "outbound", occurredAt: daysAgo(61), subject: "First contact", body: "Wants 35L for Green Meadows 3B. Wife will be co-applicant.", recordedBy: id("usr", 1) },
    { id: id("com", 2), caseId: id("cas", 1), personId: id("per", 1), channel: "whatsapp", direction: "outbound", occurredAt: daysAgo(36), subject: "HDFC sanction", body: "Shared sanction letter. Customer comparing with a competitor.", recordedBy: id("usr", 1) },
    { id: id("com", 3), caseId: id("cas", 2), personId: id("per", 5), channel: "call", direction: "inbound", occurredAt: daysAgo(2), subject: "Document follow-up", body: "Sending payslips this week.", recordedBy: id("usr", 1) },
    { id: id("com", 4), caseId: id("cas", 7), personId: id("per", 1), channel: "call", direction: "inbound", occurredAt: daysAgo(3), subject: "Top-up enquiry", body: "Asking about a top-up on the existing HDFC loan.", recordedBy: id("usr", 1) },
    { id: id("com", 5), caseId: id("cas", 5), personId: id("per", 3), channel: "call", direction: "inbound", occurredAt: daysAgo(1), subject: "Personal loan enquiry", body: "4L, wedding expenses. Salaried, will confirm employer.", recordedBy: id("usr", 1) },
  ];

  const notes: Database["notes"] = [
    { id: id("not", 1), caseId: id("cas", 1), authorId: id("usr", 2), body: "IIFL RM said FOIR is tight because of the car loan. Worth trying LIC HFL — they are more lenient on this profile.", createdAt: daysAgo(37) },
    { id: id("not", 2), caseId: id("cas", 3), authorId: id("usr", 2), body: "Sundaram raised a query on the GST returns for Q3. Awaiting the firm's accountant.", createdAt: daysAgo(9) },
    { id: id("not", 3), caseId: id("cas", 4), authorId: id("usr", 1), body: "Customer in Singapore until month end. Agreed to resume first week of next month.", createdAt: daysAgo(6) },
  ];

  const tasks: Database["tasks"] = [
    { id: id("tsk", 1), caseId: id("cas", 1), assignedTo: id("usr", 1), title: "Present HDFC offer — expires in 12 days", dueAt: daysAhead(3) },
    { id: id("tsk", 2), caseId: id("cas", 2), assignedTo: id("usr", 1), title: "Collect payslips from Arun Prasad", dueAt: daysAgo(1) },
    { id: id("tsk", 3), caseId: id("cas", 3), assignedTo: id("usr", 2), title: "Answer Sundaram query on GST returns", dueAt: daysAhead(1) },
    { id: id("tsk", 4), caseId: id("cas", 5), assignedTo: id("usr", 1), title: "Confirm employer and income for Murugan", dueAt: daysAhead(0) },
  ];

  const events: Database["events"] = [
    { id: id("evt", 1), occurredAt: daysAgo(62), actorKind: "user", actorUserId: id("usr", 1), caseId: id("cas", 1), entityType: "case", entityId: id("cas", 1), eventType: "case.created", summary: `Case ${num(41)} opened` },
    { id: id("evt", 2), occurredAt: daysAgo(61), actorKind: "user", actorUserId: id("usr", 1), caseId: id("cas", 1), entityType: "case", entityId: id("cas", 1), eventType: "case.stage_changed", summary: "New → Contacted" },
    { id: id("evt", 3), occurredAt: daysAgo(55), actorKind: "user", actorUserId: id("usr", 1), caseId: id("cas", 1), entityType: "case_party", eventType: "case.party_added", summary: "Co-applicant added: Sasirekha M — 4 new requirements" },
    { id: id("evt", 4), occurredAt: daysAgo(40), actorKind: "system", caseId: id("cas", 1), entityType: "case", eventType: "case.stage_changed", summary: "Documents Pending → Ready for Submission", causedBy: "Last applicable requirement verified" },
    { id: id("evt", 5), occurredAt: daysAgo(38), actorKind: "system", caseId: id("cas", 1), entityType: "case", eventType: "case.stage_changed", summary: "Ready for Submission → Submitted", causedBy: "Submission to HDFC Bank — Madurai Main dispatched" },
    { id: id("evt", 6), occurredAt: daysAgo(37), actorKind: "user", actorUserId: id("usr", 2), caseId: id("cas", 1), entityType: "submission", eventType: "submission.rejected", summary: "IIFL — Madurai rejected: Existing obligations too high" },
    { id: id("evt", 7), occurredAt: daysAgo(36), actorKind: "system", caseId: id("cas", 1), entityType: "case", eventType: "case.stage_changed", summary: "Submitted → Sanctioned", causedBy: "HDFC Bank — Madurai Main sanctioned, offer attached" },
    { id: id("evt", 8), occurredAt: daysAgo(95), actorKind: "user", actorUserId: id("usr", 1), caseId: id("cas", 6), entityType: "case", eventType: "case.created", summary: `Case ${num(46)} opened` },
    { id: id("evt", 9), occurredAt: daysAgo(30), actorKind: "user", actorUserId: id("usr", 1), caseId: id("cas", 6), entityType: "case", eventType: "case.marked_lost", summary: "Marked lost: Rate too high" },
    { id: id("evt", 10), occurredAt: daysAgo(6), actorKind: "user", actorUserId: id("usr", 1), caseId: id("cas", 4), entityType: "case", eventType: "case.held", summary: "Placed on hold: Customer travelling until month end" },
  ];

  return {
    people, organisations, employments, properties, users, loanProducts, documentTypes,
    rejectionReasons, cases, caseParties, caseProperties, documents,
    requirements: [], submissions, offers, communications, notes, tasks, events,
    caseNumberSequence: { [year]: 47 },
  };
}
