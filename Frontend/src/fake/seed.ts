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

  // The lending product catalogue itself is built further down, once the
  // master data it points at exists (Milestone 7).

  const documentTypes: Database["documentTypes"] = [
    { id: id("dty", 1), code: "pan_card", name: "PAN Card", ownerKind: "person", requiresPeriod: false, isActive: true, displayOrder: 10 },
    { id: id("dty", 2), code: "aadhaar_card", name: "Aadhaar Card", ownerKind: "person", requiresPeriod: false, isActive: true, displayOrder: 20 },
    { id: id("dty", 3), code: "address_proof", name: "Address Proof", ownerKind: "person", requiresPeriod: false, requiresExpiry: true, isActive: true, displayOrder: 30 },
    { id: id("dty", 4), code: "photograph", name: "Photograph", ownerKind: "person", requiresPeriod: false, isActive: true, displayOrder: 40 },
    { id: id("dty", 5), code: "salary_slip", name: "Salary Slip", ownerKind: "person", requiresPeriod: true, isActive: true, displayOrder: 50 },
    { id: id("dty", 6), code: "form_16", name: "Form 16", ownerKind: "person", requiresPeriod: true, isActive: true, displayOrder: 60 },
    { id: id("dty", 7), code: "bank_statement", name: "Bank Statement", ownerKind: "person", requiresPeriod: true, isActive: true, displayOrder: 70 },
    { id: id("dty", 8), code: "itr", name: "Income Tax Return", ownerKind: "person", requiresPeriod: true, isActive: true, displayOrder: 80 },
    { id: id("dty", 9), code: "gst_certificate", name: "GST Certificate", ownerKind: "organisation", requiresPeriod: false, isActive: true, displayOrder: 90 },
    // financial_statements is retained (not deleted, per BR-027's pattern) but
    // no longer generated — superseded by the two split-out, financial-year-
    // scoped types below (Database/migrations/0011).
    { id: id("dty", 10), code: "financial_statements", name: "Financial Statements", ownerKind: "organisation", requiresPeriod: true, isActive: false, displayOrder: 100 },
    { id: id("dty", 17), code: "gst_returns", name: "GST Returns", ownerKind: "organisation", requiresPeriod: true, isActive: true, displayOrder: 110 },
    { id: id("dty", 18), code: "balance_sheet", name: "Balance Sheet", ownerKind: "organisation", requiresPeriod: true, isActive: true, displayOrder: 120 },
    { id: id("dty", 19), code: "profit_and_loss", name: "Profit and Loss Statement", ownerKind: "organisation", requiresPeriod: true, isActive: true, displayOrder: 130 },
    { id: id("dty", 11), code: "sale_deed", name: "Sale Deed", ownerKind: "property", requiresPeriod: false, isActive: true, displayOrder: 140 },
    { id: id("dty", 12), code: "encumbrance_cert", name: "Encumbrance Certificate", ownerKind: "property", requiresPeriod: true, isActive: true, displayOrder: 150 },
    { id: id("dty", 13), code: "approved_plan", name: "Approved Building Plan", ownerKind: "property", requiresPeriod: false, isActive: true, displayOrder: 160 },
    { id: id("dty", 14), code: "valuation_report", name: "Valuation Report", ownerKind: "property", requiresPeriod: false, requiresExpiry: true, isActive: true, displayOrder: 170 },
    { id: id("dty", 15), code: "login_form", name: "Login Form", ownerKind: "case", requiresPeriod: false, isActive: true, displayOrder: 180 },
    { id: id("dty", 16), code: "sanction_letter", name: "Sanction Letter", ownerKind: "case", requiresPeriod: false, requiresExpiry: true, isActive: true, displayOrder: 190 },
  ];

  const rejectionReasons: Database["rejectionReasons"] = [
    { id: id("rej", 1), code: "credit_history", name: "Credit history", displayOrder: 10, isActive: true },
    { id: id("rej", 2), code: "income_insufficient", name: "Income insufficient", displayOrder: 20, isActive: true },
    { id: id("rej", 3), code: "obligations_too_high", name: "Existing obligations too high", displayOrder: 30, isActive: true },
    { id: id("rej", 4), code: "vintage_insufficient", name: "Employment or business vintage insufficient", displayOrder: 40, isActive: true },
    { id: id("rej", 5), code: "documents_incomplete", name: "Documents incomplete", displayOrder: 50, isActive: true },
    { id: id("rej", 6), code: "document_discrepancy", name: "Document discrepancy", displayOrder: 60, isActive: true },
    { id: id("rej", 7), code: "banking_unsatisfactory", name: "Banking conduct unsatisfactory", displayOrder: 70, isActive: true },
    { id: id("rej", 8), code: "property_legal", name: "Property — legal or title issue", displayOrder: 80, isActive: true },
    { id: id("rej", 9), code: "property_technical", name: "Property — technical or valuation issue", displayOrder: 90, isActive: true },
    { id: id("rej", 10), code: "age_tenure_mismatch", name: "Age or tenure mismatch", displayOrder: 100, isActive: true },
    { id: id("rej", 11), code: "profile_or_area_policy", name: "Profile or area policy", displayOrder: 110, isActive: true },
    { id: id("rej", 12), code: "product_not_offered", name: "Product not offered", displayOrder: 120, isActive: true },
  ];

  // ---------------------------------------------------------------------
  // Master Data Engine (Milestone 5) — Database/migrations/0012, 0013.
  // Mirrors the DB seed exactly, so the prototype and the schema agree on
  // what "the starting master data" means.
  // ---------------------------------------------------------------------

  // Renamed from loanCategories in Milestone 7.1 (ADR-033) — this already
  // modelled what a telecaller calls a "Customer Product" (Home Loan,
  // Business Loan, LAP), grouping the lending products underneath it.
  // Business Loan is ordered ahead of Home Loan (Coimbatore-first, Part 5 of
  // the milestone brief): Amaze's stated footprint (Database/migrations/0014)
  // is an engineering, textile and transport ecosystem more than a
  // metros-first, purely-residential one.
  const customerProducts: Database["customerProducts"] = [
    { id: id("lct", 2), code: "business_loan", name: "Business Loan", description: "Working capital and term finance for a running business, funded and non-funded.", isActive: true, displayOrder: 10 },
    { id: id("lct", 1), code: "home_loan", name: "Home Loan", description: "Purchase, construction, improvement and refinance of residential property.", isActive: true, displayOrder: 20 },
    { id: id("lct", 3), code: "lap", name: "Loan Against Property", description: "Lending against property already owned, for any declared end use.", isActive: true, displayOrder: 30 },
    { id: id("lct", 4), code: "personal_loan", name: "Personal Loan", description: "Unsecured lending to an individual against income, for any personal end use.", isActive: true, displayOrder: 40 },
    // Four more business lines (Milestone 7, Database/migrations/0016).
    { id: id("lct", 5), code: "vehicle_loan", name: "Vehicle Loan", description: "Finance against a new or used vehicle, secured by hypothecation of the vehicle itself.", isActive: true, displayOrder: 50 },
    { id: id("lct", 6), code: "gold_loan", name: "Gold Loan", description: "Short-tenure lending against pledged gold ornaments. Fast, small-ticket, no income proof in most cases.", isActive: true, displayOrder: 60 },
    { id: id("lct", 7), code: "education_loan", name: "Education Loan", description: "Finance for higher education in India or overseas, usually with a moratorium during the course.", isActive: true, displayOrder: 70 },
    { id: id("lct", 8), code: "loan_against_securities", name: "Loan Against Securities", description: "Overdraft or demand loan against pledged financial assets — shares, mutual funds, fixed deposits.", isActive: true, displayOrder: 80 },
  ];

  const employmentTypes: Database["employmentTypes"] = [
    { id: id("emt", 1), code: "salaried", name: "Salaried", description: "Draws a fixed salary from an employer. Payslips and Form 16 are the usual income evidence.", isActive: true, displayOrder: 10 },
    { id: id("emt", 2), code: "self_employed", name: "Self-Employed", description: "Runs a profession or business in their own name. ITR and bank statements substitute for payslips.", isActive: true, displayOrder: 20 },
    { id: id("emt", 3), code: "business_owner", name: "Business Owner", description: "Owns or is a partner in a firm, which may itself be a case party.", isActive: true, displayOrder: 30 },
  ];

  const businessConstitutions: Database["businessConstitutions"] = [
    { id: id("bct", 1), code: "proprietorship", name: "Sole Proprietorship", description: "One individual owns the business; no separate legal entity.", isActive: true, displayOrder: 10 },
    { id: id("bct", 2), code: "partnership", name: "Partnership", description: "Governed by a partnership deed; two or more partners.", isActive: true, displayOrder: 20 },
    { id: id("bct", 3), code: "llp", name: "Limited Liability Partnership", description: "Registered LLP — partners with limited liability.", isActive: true, displayOrder: 30 },
    { id: id("bct", 4), code: "private_limited", name: "Private Limited Company", description: "Registered under the Companies Act, shares not publicly traded.", isActive: true, displayOrder: 40 },
    { id: id("bct", 5), code: "public_limited", name: "Public Limited Company", description: "Registered under the Companies Act, shares publicly traded.", isActive: true, displayOrder: 50 },
    { id: id("bct", 6), code: "huf", name: "Hindu Undivided Family", description: "A HUF as recognised for tax and lending purposes.", isActive: true, displayOrder: 60 },
    { id: id("bct", 7), code: "trust_society", name: "Trust / Society", description: "A registered trust or society rather than a commercial entity.", isActive: true, displayOrder: 70 },
  ];

  const propertyTypes: Database["propertyTypes"] = [
    { id: id("pty", 1), code: "apartment", name: "Apartment", isActive: true, displayOrder: 10 },
    { id: id("pty", 2), code: "independent_house", name: "Independent House", isActive: true, displayOrder: 20 },
    { id: id("pty", 3), code: "villa", name: "Villa", isActive: true, displayOrder: 30 },
    { id: id("pty", 4), code: "plot", name: "Plot", isActive: true, displayOrder: 40 },
    { id: id("pty", 5), code: "commercial", name: "Commercial", isActive: true, displayOrder: 50 },
    { id: id("pty", 6), code: "agricultural_land", name: "Agricultural Land", isActive: true, displayOrder: 60 },
  ];

  const propertyOwnershipTypes: Database["propertyOwnershipTypes"] = [
    { id: id("pot", 1), code: "freehold", name: "Freehold", description: "Outright ownership, no lease term.", isActive: true, displayOrder: 10 },
    { id: id("pot", 2), code: "leasehold", name: "Leasehold", description: "Held under a lease for a fixed term.", isActive: true, displayOrder: 20 },
    { id: id("pot", 3), code: "ancestral", name: "Ancestral", description: "Inherited, typically undivided among family members.", isActive: true, displayOrder: 30 },
    { id: id("pot", 4), code: "power_of_attorney", name: "Power of Attorney", description: "Held or transacted through a registered power of attorney.", isActive: true, displayOrder: 40 },
    { id: id("pot", 5), code: "joint_ownership", name: "Joint Ownership", description: "Title held jointly by two or more named owners.", isActive: true, displayOrder: 50 },
  ];

  const referralSources: Database["referralSources"] = [
    { id: id("rfs", 1), code: "phone_enquiry", name: "Phone Enquiry", isActive: true, displayOrder: 10 },
    { id: id("rfs", 2), code: "walk_in", name: "Walk-in", isActive: true, displayOrder: 20 },
    { id: id("rfs", 3), code: "referral", name: "Referral", isActive: true, displayOrder: 30 },
    { id: id("rfs", 4), code: "repeat_customer", name: "Repeat Customer", isActive: true, displayOrder: 40 },
    { id: id("rfs", 5), code: "builder_tie_up", name: "Builder Tie-up", isActive: true, displayOrder: 50 },
    { id: id("rfs", 6), code: "website", name: "Website", isActive: true, displayOrder: 60 },
    { id: id("rfs", 7), code: "social_media", name: "Social Media", isActive: true, displayOrder: 70 },
  ];

  // Amaze's actual operating footprint (Milestone 6, Part 1) — Coimbatore,
  // Tiruppur and Erode districts, and the towns Amaze works cases in day to
  // day. Extending into Kerala, Karnataka or the rest of India later is
  // purely more rows here, never a structural change (Database/migrations/
  // 0014): city already carries district_id, district already carries a free
  // -text `state`, and a state gains its first row the same way a district
  // does — by naming it on a district, not by adding a table.
  //
  // The earlier demo geography (Madurai, Chennai, Mumbai) is kept, inactive,
  // matching the never-delete convention Database/migrations/0014 uses on
  // the real schema — and giving the admin screen something real to show
  // under "Reactivate".
  const districts: Database["districts"] = [
    { id: id("dst", 1), code: "madurai", name: "Madurai", state: "Tamil Nadu", isActive: false, displayOrder: 10 },
    { id: id("dst", 2), code: "chennai", name: "Chennai", state: "Tamil Nadu", isActive: false, displayOrder: 20 },
    { id: id("dst", 3), code: "mumbai_mmr", name: "Mumbai", state: "Maharashtra", isActive: false, displayOrder: 30 },
    { id: id("dst", 4), code: "coimbatore", name: "Coimbatore", state: "Tamil Nadu", isActive: true, displayOrder: 40 },
    { id: id("dst", 5), code: "tiruppur", name: "Tiruppur", state: "Tamil Nadu", isActive: true, displayOrder: 50 },
    { id: id("dst", 6), code: "erode", name: "Erode", state: "Tamil Nadu", isActive: true, displayOrder: 60 },
  ];

  const cities: Database["cities"] = [
    { id: id("cty", 1), code: "madurai", name: "Madurai", districtId: id("dst", 1), isActive: false, displayOrder: 10 },
    { id: id("cty", 2), code: "chennai", name: "Chennai", districtId: id("dst", 2), isActive: false, displayOrder: 20 },
    { id: id("cty", 3), code: "mumbai", name: "Mumbai", districtId: id("dst", 3), isActive: false, displayOrder: 30 },
    { id: id("cty", 4), code: "coimbatore", name: "Coimbatore", districtId: id("dst", 4), isActive: true, displayOrder: 40 },
    { id: id("cty", 5), code: "tiruppur", name: "Tiruppur", districtId: id("dst", 5), isActive: true, displayOrder: 50 },
    { id: id("cty", 6), code: "erode", name: "Erode", districtId: id("dst", 6), isActive: true, displayOrder: 60 },
    { id: id("cty", 7), code: "pollachi", name: "Pollachi", districtId: id("dst", 4), isActive: true, displayOrder: 70 },
    { id: id("cty", 8), code: "mettupalayam", name: "Mettupalayam", districtId: id("dst", 4), isActive: true, displayOrder: 80 },
    { id: id("cty", 9), code: "palladam", name: "Palladam", districtId: id("dst", 5), isActive: true, displayOrder: 90 },
    { id: id("cty", 10), code: "udumalpet", name: "Udumalpet", districtId: id("dst", 5), isActive: true, displayOrder: 100 },
    { id: id("cty", 11), code: "kinathukadavu", name: "Kinathukadavu", districtId: id("dst", 4), isActive: true, displayOrder: 110 },
    { id: id("cty", 12), code: "sulur", name: "Sulur", districtId: id("dst", 4), isActive: true, displayOrder: 120 },
    { id: id("cty", 13), code: "annur", name: "Annur", districtId: id("dst", 4), isActive: true, displayOrder: 130 },
  ];

  // ---------------------------------------------------------------------
  // Lending Product Catalogue (Milestone 7) — Database/migrations/0015, 0016.
  // Mirrors the DB seed, so the prototype and the schema agree on what Amaze
  // lends against.
  // ---------------------------------------------------------------------

  const borrowerTypes: Database["borrowerTypes"] = [
    { id: id("bwt", 1), code: "resident_individual", name: "Resident Individual", description: "A natural person resident in India. The default borrower for most retail products.", isActive: true, displayOrder: 10 },
    { id: id("bwt", 2), code: "nri_individual", name: "NRI Individual", description: "A non-resident Indian or person of Indian origin. Separate documentation, repayment from NRE/NRO accounts.", isActive: true, displayOrder: 20 },
    { id: id("bwt", 3), code: "non_individual", name: "Non-Individual Entity", description: "A firm, company, LLP, HUF or trust borrowing in its own name.", isActive: true, displayOrder: 30 },
  ];

  const securityTypes: Database["securityTypes"] = [
    { id: id("sct", 1), code: "unsecured", name: "Unsecured (Clean)", description: "No security. Priced against income and credit history alone.", isActive: true, displayOrder: 10 },
    { id: id("sct", 2), code: "immovable_property", name: "Mortgage of Immovable Property", description: "Equitable or registered mortgage of land or built property.", isActive: true, displayOrder: 20 },
    { id: id("sct", 3), code: "gold_pledge", name: "Pledge of Gold Ornaments", description: "Physical gold held by the lender for the tenure of the loan.", isActive: true, displayOrder: 30 },
    { id: id("sct", 4), code: "vehicle_hypothecation", name: "Hypothecation of Vehicle", description: "The financed vehicle itself, endorsed in the registration certificate.", isActive: true, displayOrder: 40 },
    { id: id("sct", 5), code: "plant_machinery", name: "Hypothecation of Plant and Machinery", description: "The financed equipment, plant or machinery.", isActive: true, displayOrder: 50 },
    { id: id("sct", 6), code: "stock_book_debts", name: "Hypothecation of Stock and Book Debts", description: "Current assets of a running business — inventory and receivables.", isActive: true, displayOrder: 60 },
    { id: id("sct", 7), code: "financial_securities", name: "Pledge of Financial Securities", description: "Shares, mutual fund units, bonds or deposits pledged with the lender.", isActive: true, displayOrder: 70 },
    { id: id("sct", 8), code: "guarantee_backed", name: "Guarantee Backed", description: "Secured by a guarantee rather than an asset — CGTMSE, CGFMU or a third-party personal guarantee.", isActive: true, displayOrder: 80 },
  ];

  const requirementApplicabilities: Database["requirementApplicabilities"] = [
    { id: id("rqa", 1), code: "mandatory", name: "Mandatory", description: "The product cannot proceed without it.", isActive: true, displayOrder: 10 },
    { id: id("rqa", 2), code: "optional", name: "Optional", description: "Accepted and sometimes asked for, but the product exists without it.", isActive: true, displayOrder: 20 },
    { id: id("rqa", 3), code: "not_applicable", name: "Not Applicable", description: "The product has no use for it. Nothing should ask.", isActive: true, displayOrder: 30 },
  ];

  /** Resolves a master-data code to its seeded id, loudly. A typo in the
   * table below should fail at seed time, not show a blank field later. */
  function idOf(list: readonly { id: string; code: string }[], code: string): string {
    const found = list.find((record) => record.code === code);
    if (!found) throw new Error(`Seed error: no master data row with code "${code}"`);
    return found.id;
  }

  const codes = (csv: string): string[] => (csv ? csv.split(",") : []);

  /**
   * The catalogue, in the same order and with the same content as
   * Database/migrations/0016. Written as a table rather than as object
   * literals because thirty-five products of fourteen fields each is only
   * reviewable as a table — the same reason the migration writes it as one.
   *
   * Columns: seed id, code, customer product, name, variant (the legacy
   * free-text column, still populated), security, property requirement, GST
   * requirement, borrower types, employment types, business constitutions,
   * tenure months, amount rupees, description, typical customer profile,
   * typical documents summary. The last two are Milestone 7.1 (ADR-033,
   * Database/migrations/0018) — informational only, never an eligibility
   * rule.
   *
   * Ids 1–9 keep the products the earlier seed had, so the seeded cases
   * still point at the products they always pointed at.
   */
  const catalogue: Array<[
    number, string, string, string, string, string, string, string,
    string, string, string, number, number, number, number, string,
    string, string,
  ]> = [
    [1, "hl_purchase", "home_loan", "Home Loan — Purchase", "Purchase", "immovable_property", "mandatory", "optional", "resident_individual,nri_individual", "salaried,self_employed,business_owner", "", 60, 360, 500000, 100000000, "Purchase of a ready or under-construction residential property from a builder or a resale seller.", "Salaried Employee, Self-Employed Professional", "PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Sale Agreement, Property Documents"],
    [2, "hl_self_construct", "home_loan", "Home Construction Loan", "Self Construction", "immovable_property", "mandatory", "optional", "resident_individual,nri_individual", "salaried,self_employed,business_owner", "", 60, 300, 500000, 50000000, "Construction of a house on a plot the borrower already owns. Disbursed in stages against construction progress.", "Salaried Employee, Self-Employed Professional owning a plot", "PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Approved Plan, Estimate, Property Documents"],
    [3, "hl_plot_purchase", "home_loan", "Plot Purchase Loan", "Plot Purchase", "immovable_property", "mandatory", "optional", "resident_individual", "salaried,self_employed,business_owner", "", 36, 180, 500000, 30000000, "Purchase of residential land, with no construction commitment. Shorter tenure and lower funding than a home loan.", "Salaried Employee, Self-Employed Professional", "PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Sale Agreement, Property Documents"],
    [10, "hl_plot_construction", "home_loan", "Composite Plot and Construction Loan", "Plot and Construction", "immovable_property", "mandatory", "optional", "resident_individual", "salaried,self_employed,business_owner", "", 60, 300, 500000, 50000000, "One sanction covering the purchase of a plot and the construction on it, disbursed in two phases.", "Salaried Employee, Self-Employed Professional", "PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Sale Agreement, Approved Plan, Property Documents"],
    [11, "hl_improvement", "home_loan", "Home Improvement Loan", "Improvement", "immovable_property", "mandatory", "optional", "resident_individual", "salaried,self_employed,business_owner", "", 12, 180, 100000, 5000000, "Renovation, repair or interior work on a property the borrower owns.", "Salaried Employee, existing Homeowner", "PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Estimate, Property Documents"],
    [12, "hl_extension", "home_loan", "Home Extension Loan", "Extension", "immovable_property", "mandatory", "optional", "resident_individual", "salaried,self_employed,business_owner", "", 36, 240, 200000, 10000000, "Adding built-up area to an existing house. Needs approved plans, which renovation usually does not.", "Salaried Employee, existing Homeowner", "PAN, Aadhaar, Income Proof, Bank Statement (6 Months), Approved Plan, Estimate, Property Documents"],
    [4, "hl_balance_transfer", "home_loan", "Home Loan Balance Transfer", "Balance Transfer", "immovable_property", "mandatory", "optional", "resident_individual,nri_individual", "salaried,self_employed,business_owner", "", 36, 360, 500000, 100000000, "Takeover of an existing home loan from another lender, usually for a lower rate.", "Salaried Employee, Self-Employed Professional with an existing home loan", "PAN, Aadhaar, Existing Loan Statement, Foreclosure Letter, Bank Statement (6 Months), Property Documents"],
    [5, "hl_top_up", "home_loan", "Home Loan Top-up", "Top-up", "immovable_property", "mandatory", "optional", "resident_individual,nri_individual", "salaried,self_employed,business_owner", "", 12, 240, 100000, 10000000, "Additional lending on an existing home loan, against the same mortgage.", "Existing Home Loan Customer", "PAN, Aadhaar, Existing Loan Statement, Bank Statement (6 Months), Property Documents"],
    [13, "hl_nri", "home_loan", "NRI Home Loan", "NRI", "immovable_property", "mandatory", "not_applicable", "nri_individual", "salaried,self_employed", "", 60, 300, 1000000, 100000000, "Home loan to a non-resident Indian. Same security, different documentation — passport and visa, overseas income proof, a resident power of attorney holder.", "NRI", "Passport, Visa, Overseas Income Proof, NRE/NRO Bank Statement (6 Months), Power of Attorney, Property Documents"],
    [14, "hl_affordable", "home_loan", "Affordable Housing Loan", "Affordable Housing", "immovable_property", "mandatory", "optional", "resident_individual", "salaried,self_employed,business_owner", "", 60, 240, 200000, 5000000, "Small-ticket home loan for the informal-income segment, the space affordable housing finance companies specialise in.", "Salaried Employee (Informal Income), Self-Employed with modest income", "PAN, Aadhaar, Income Proof or Self-Declaration, Bank Statement (6 Months), Property Documents"],

    [6, "bl_working_capital", "business_loan", "Working Capital Facility (Cash Credit)", "Working Capital", "stock_book_debts", "optional", "mandatory", "resident_individual,non_individual", "self_employed,business_owner", "proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society", 12, 12, 500000, 100000000, "A revolving limit against stock and receivables, renewed annually rather than repaid in EMIs. The standard facility for Coimbatore's pump, foundry and textile units financing raw material and work-in-progress.", "MSME Manufacturer, Textile Unit", "PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Stock Statement, Financial Statements"],
    [15, "bl_overdraft", "business_loan", "Business Overdraft", "Overdraft", "immovable_property", "optional", "mandatory", "resident_individual,non_individual", "self_employed,business_owner", "proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society", 12, 12, 200000, 50000000, "A drawing limit on the current account, secured by property or deposits. Interest on the drawn balance only.", "MSME Manufacturer, Retail Shop", "PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Property Documents"],
    [7, "bl_term_loan", "business_loan", "Business Term Loan", "Term Loan", "immovable_property", "optional", "mandatory", "resident_individual,non_individual", "self_employed,business_owner", "proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society", 12, 120, 500000, 100000000, "A fixed-tenure loan repaid in EMIs, for a defined business purpose.", "MSME Manufacturer, Textile Unit, Retail Shop", "PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Project Report, Property Documents"],
    [16, "bl_unsecured", "business_loan", "Unsecured Business Loan", "Unsecured", "unsecured", "not_applicable", "mandatory", "resident_individual,non_individual", "self_employed,business_owner", "proprietorship,partnership,llp,private_limited", 12, 60, 100000, 7500000, "Clean business lending priced against banking turnover and GST returns. The NBFC segment's core offering.", "Retail Shop, Trading Firm, Small Business Owner", "PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months)"],
    [17, "bl_machinery", "business_loan", "Machinery and Equipment Loan", "Machinery", "plant_machinery", "optional", "mandatory", "resident_individual,non_individual", "self_employed,business_owner", "proprietorship,partnership,llp,private_limited,public_limited", 12, 84, 300000, 50000000, "Finance for plant, machinery or equipment, secured by the asset being financed. Common in Coimbatore's engineering and textile units.", "MSME Manufacturer, Textile Unit, Engineering Workshop", "PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Machinery Quotation, Udyam Registration"],
    [18, "bl_msme_cgtmse", "business_loan", "MSME Term Loan (CGTMSE-backed)", "MSME CGTMSE", "guarantee_backed", "not_applicable", "mandatory", "resident_individual,non_individual", "self_employed,business_owner", "proprietorship,partnership,llp,private_limited,huf", 12, 84, 100000, 20000000, "Collateral-free term finance to a registered MSME under the CGTMSE guarantee scheme. Needs Udyam registration. Common among Coimbatore's smaller engineering and job-work units taking their first formal credit line.", "MSME Manufacturer, Textile Unit", "PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Udyam Registration"],
    [19, "bl_mudra", "business_loan", "Mudra Loan (PMMY)", "Mudra", "guarantee_backed", "not_applicable", "optional", "resident_individual,non_individual", "self_employed,business_owner", "proprietorship,partnership,huf", 12, 60, 10000, 2000000, "Micro-enterprise finance under the Pradhan Mantri Mudra Yojana, in the Shishu, Kishore, Tarun and Tarun Plus tiers.", "Micro Enterprise, Retail Shop, Small Trader", "PAN, Aadhaar, Business Proof, Bank Statement (6 Months)"],
    [20, "bl_bill_discounting", "business_loan", "Bill and Invoice Discounting", "Bill Discounting", "stock_book_debts", "not_applicable", "mandatory", "resident_individual,non_individual", "self_employed,business_owner", "proprietorship,partnership,llp,private_limited,public_limited", 1, 12, 500000, 50000000, "Advance against accepted invoices or bills of exchange, repaid when the buyer pays.", "MSME Manufacturer, Trading Firm supplying larger buyers", "PAN, Aadhaar, GST, Invoices/Bills, Buyer Acceptance, Bank Statement (6 Months)"],
    [21, "bl_non_fund_based", "business_loan", "Bank Guarantee and Letter of Credit", "Non-Fund Based", "guarantee_backed", "optional", "mandatory", "resident_individual,non_individual", "self_employed,business_owner", "proprietorship,partnership,llp,private_limited,public_limited", 1, 36, 100000, 50000000, "Non-fund-based limits. No money moves unless the instrument is invoked, but the limit is assessed like any other exposure.", "MSME Manufacturer, Contractor, Trading Firm", "PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Contract or Tender Document"],

    [8, "lap", "lap", "Loan Against Property — Residential", "Loan Against Property", "immovable_property", "mandatory", "optional", "resident_individual,nri_individual,non_individual", "salaried,self_employed,business_owner", "proprietorship,partnership,llp,private_limited,huf", 36, 240, 500000, 100000000, "Mortgage of a residential property the borrower already owns, for a declared end use.", "Salaried Employee, MSME Manufacturer, Retail Shop owner", "PAN, Aadhaar, Income Proof or GST/ITR, Bank Statement (12 Months), Property Documents"],
    [22, "lap_commercial", "lap", "Loan Against Property — Commercial", "Commercial Property", "immovable_property", "mandatory", "mandatory", "resident_individual,non_individual", "self_employed,business_owner", "proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society", 36, 180, 500000, 100000000, "Mortgage of a shop, office, godown or industrial unit. Lower funding ratio and tighter valuation than residential LAP. Frequently taken against a factory shed or godown by a Coimbatore engineering or textile business raising working-capital margin.", "MSME Manufacturer, Textile Unit, Trading Firm", "PAN, Aadhaar, GST, ITR (2 FY), Bank Statement (12 Months), Property Documents"],
    [23, "lap_lrd", "lap", "Lease Rental Discounting", "Lease Rental Discounting", "immovable_property", "mandatory", "optional", "resident_individual,non_individual", "salaried,self_employed,business_owner", "proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society", 36, 180, 2000000, 200000000, "Lending against rent receivable under a registered lease, repaid from the rent itself. Assessed on the tenant's covenant, not the landlord's income.", "Property Owner with a leased commercial property", "PAN, Aadhaar, Registered Lease Deed, Tenant KYC, Bank Statement (12 Months), Property Documents"],
    [24, "lap_balance_transfer", "lap", "LAP Balance Transfer and Top-up", "Balance Transfer", "immovable_property", "mandatory", "optional", "resident_individual,non_individual", "salaried,self_employed,business_owner", "proprietorship,partnership,llp,private_limited,huf", 36, 240, 500000, 100000000, "Takeover of an existing loan against property, usually with additional lending on the same security.", "Existing LAP Customer, MSME Manufacturer", "PAN, Aadhaar, Existing Loan Statement, Foreclosure Letter, Bank Statement (12 Months), Property Documents"],

    [9, "pl", "personal_loan", "Personal Loan — Salaried", "Personal Loan", "unsecured", "not_applicable", "not_applicable", "resident_individual", "salaried", "", 12, 72, 50000, 4000000, "Unsecured lending to a salaried individual against take-home income and employer category.", "Salaried Employee", "PAN, Aadhaar, Salary Slips (3 Months), Bank Statement (6 Months), Form 16"],
    [25, "pl_self_employed", "personal_loan", "Personal Loan — Self-Employed", "Self-Employed", "unsecured", "not_applicable", "optional", "resident_individual", "self_employed,business_owner", "", 12, 60, 50000, 2500000, "Unsecured personal lending assessed on ITR and banking rather than on payslips.", "Self-Employed Professional, Small Business Owner", "PAN, Aadhaar, ITR (2 FY), Bank Statement (12 Months)"],
    [26, "pl_professional", "personal_loan", "Professional Loan", "Professional", "unsecured", "not_applicable", "optional", "resident_individual", "self_employed", "", 12, 84, 100000, 7500000, "Unsecured lending to a qualified professional — doctor, chartered accountant, architect — priced off the qualification and practice vintage. A steady draw among Coimbatore's doctors and chartered accountants setting up or expanding a practice.", "Doctor, Chartered Accountant, Architect, Engineer", "PAN, Aadhaar, Qualification Proof, ITR (2 FY), Bank Statement (12 Months)"],

    [27, "vl_new_car", "vehicle_loan", "New Car Loan", "New Car", "vehicle_hypothecation", "not_applicable", "not_applicable", "resident_individual,non_individual", "salaried,self_employed,business_owner", "proprietorship,partnership,llp,private_limited,public_limited", 12, 84, 100000, 10000000, "Finance for a new passenger vehicle, secured by hypothecation endorsed in the registration certificate.", "Salaried Employee, Self-Employed Professional", "PAN, Aadhaar, Income Proof, Bank Statement (3 Months), Vehicle Quotation"],
    [28, "vl_used_car", "vehicle_loan", "Used Car Loan", "Used Car", "vehicle_hypothecation", "not_applicable", "not_applicable", "resident_individual", "salaried,self_employed,business_owner", "", 12, 60, 100000, 5000000, "Finance for a pre-owned vehicle. Tenure is capped by the vehicle's age.", "Salaried Employee, Self-Employed Professional", "PAN, Aadhaar, Income Proof, Bank Statement (3 Months), Vehicle RC, Valuation Report"],
    [29, "vl_two_wheeler", "vehicle_loan", "Two-Wheeler Loan", "Two-Wheeler", "vehicle_hypothecation", "not_applicable", "not_applicable", "resident_individual", "salaried,self_employed,business_owner", "", 12, 48, 20000, 500000, "Small-ticket finance for a motorcycle or scooter, usually sourced at the dealership.", "Salaried Employee, Student with a co-applicant", "PAN or Aadhaar, Income Proof or Co-applicant Income Proof, Vehicle Quotation"],
    [30, "vl_commercial_vehicle", "vehicle_loan", "Commercial Vehicle Loan", "Commercial Vehicle", "vehicle_hypothecation", "not_applicable", "optional", "resident_individual,non_individual", "self_employed,business_owner", "proprietorship,partnership,llp,private_limited", 12, 60, 200000, 20000000, "Finance for goods or passenger commercial vehicles, assessed on the transport business's route and earnings. Coimbatore and Tiruppur's transport operators moving textile and engineering goods are the core market for this product.", "Transport Operator, Logistics Firm", "PAN, Aadhaar, Route Permit, Bank Statement (6 Months), Vehicle Quotation"],

    [31, "gl_gold", "gold_loan", "Gold Loan", "Gold Loan", "gold_pledge", "not_applicable", "not_applicable", "resident_individual", "salaried,self_employed,business_owner", "", 3, 36, 10000, 5000000, "Short-tenure lending against pledged gold ornaments, disbursed the same day. The security is the whole underwriting.", "Salaried Employee, Retail Shop owner, Any individual with gold to pledge", "PAN or Aadhaar, Gold Ornaments for Appraisal"],

    [32, "el_domestic", "education_loan", "Education Loan — Domestic", "Domestic", "unsecured", "optional", "not_applicable", "resident_individual", "salaried,self_employed,business_owner", "", 12, 180, 50000, 5000000, "Finance for higher education in India, with a moratorium covering the course. Small tickets are collateral-free.", "Educational Institution Applicant, Student with a co-applicant", "PAN, Aadhaar, Admission Letter, Fee Structure, Co-applicant Income Proof, Bank Statement (6 Months)"],
    [33, "el_abroad", "education_loan", "Education Loan — Overseas", "Overseas", "immovable_property", "mandatory", "not_applicable", "resident_individual", "salaried,self_employed,business_owner", "", 12, 180, 500000, 20000000, "Finance for study abroad, covering tuition and living costs. Almost always needs collateral and a resident co-applicant.", "Student with a resident co-applicant", "PAN, Aadhaar, Passport, Admission Letter, Fee Structure, Co-applicant Income Proof, Property Documents"],

    [34, "las_shares_mf", "loan_against_securities", "Loan Against Shares and Mutual Funds", "Shares and Mutual Funds", "financial_securities", "not_applicable", "not_applicable", "resident_individual,non_individual", "salaried,self_employed,business_owner", "proprietorship,partnership,llp,private_limited", 12, 36, 100000, 50000000, "An overdraft against pledged listed shares or mutual fund units, with the limit revised as the market moves.", "Salaried Employee, Retail Investor", "PAN, Aadhaar, Demat/Portfolio Statement"],
    [35, "las_fd", "loan_against_securities", "Loan Against Fixed Deposit", "Fixed Deposit", "financial_securities", "not_applicable", "not_applicable", "resident_individual,non_individual", "salaried,self_employed,business_owner", "proprietorship,partnership,llp,private_limited,public_limited,huf,trust_society", 3, 60, 10000, 50000000, "An overdraft against the borrower's own term deposit. The cheapest borrowing available to a depositor.", "Any Fixed Deposit Holder", "PAN, Aadhaar, Fixed Deposit Receipt"],
  ];

  const loanProducts: Database["loanProducts"] = catalogue.map((row, index) => {
    const [
      seedId, code, customerProductCode, name, variant, securityCode, propertyReq, gstReq,
      borrowerCodes, employmentCodes, constitutionCodes,
      minTenureMonths, maxTenureMonths, minAmount, maxAmount, description,
      typicalCustomerProfile, typicalDocumentsSummary,
    ] = row;
    const customerProduct = customerProducts.find((c) => c.code === customerProductCode);
    if (!customerProduct) throw new Error(`Seed error: no customer product "${customerProductCode}"`);
    return {
      id: id("lpr", seedId),
      code,
      // The legacy free-text pair, still populated so nothing reading it
      // breaks (Database/migrations/0015).
      category: customerProduct.name,
      variant,
      customerProductId: customerProduct.id,
      name,
      description,
      securityTypeId: idOf(securityTypes, securityCode),
      propertyRequirementId: idOf(requirementApplicabilities, propertyReq),
      gstRequirementId: idOf(requirementApplicabilities, gstReq),
      borrowerTypeIds: codes(borrowerCodes).map((c) => idOf(borrowerTypes, c)),
      employmentTypeIds: codes(employmentCodes).map((c) => idOf(employmentTypes, c)),
      businessConstitutionIds: codes(constitutionCodes).map((c) => idOf(businessConstitutions, c)),
      minTenureMonths,
      maxTenureMonths,
      minAmount,
      maxAmount,
      isActive: true,
      availabilityStatus: "active",
      typicalCustomerProfile,
      typicalDocumentsSummary,
      displayOrder: (index + 1) * 10,
    };
  });

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
    rejectionReasons,
    customerProducts, employmentTypes, businessConstitutions, propertyTypes,
    propertyOwnershipTypes, referralSources, districts, cities,
    borrowerTypes, securityTypes, requirementApplicabilities,
    cases, caseParties, caseProperties, documents,
    requirements: [], submissions, offers, communications, notes, tasks, events,
    caseNumberSequence: { [year]: 47 },
  };
}
