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
import {
  BASE_DOCUMENT_TYPES,
  DEFAULT_REQUIREMENT_RULES,
  ENGINE_DOCUMENT_TYPES,
} from "@domain/requirements/index.js";

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

  /**
   * The ids the eighteen pre-engine document types have always had. Frozen:
   * seeded documents, requirements and storage paths all point at them, so
   * the ids stay put even though the Telecaller Workflow milestone rewrote
   * every one of their names.
   *
   * Numbering is not in list order because it is not in list order in the
   * database either — 17, 18 and 19 were added by migration 0011 after 16.
   */
  const BASE_DOCUMENT_TYPE_IDS: Record<string, number> = {
    pan_card: 1, aadhaar_card: 2, address_proof: 3, photograph: 4,
    salary_slip: 5, form_16: 6, bank_statement: 7, itr: 8,
    gst_certificate: 9, gst_returns: 17, balance_sheet: 18, profit_and_loss: 19,
    sale_deed: 11, encumbrance_cert: 12, approved_plan: 13, valuation_report: 14,
    login_form: 15, sanction_letter: 16,
  };

  /**
   * Names, local names, descriptions and categories all come from
   * @domain/requirements/document-catalogue.ts rather than being restated
   * here. That is what lets one edit fix the wording everywhere: the seed, the
   * SQL migration and the checklist a telecaller reads out are the same
   * sentence, not three sentences that drifted.
   *
   * A rule naming a type nobody created generates NOTHING, which looks exactly
   * like a case that does not need the document — so one definition, shared
   * with Database/migrations/0022, is the only way to be sure.
   */
  const fromCatalogue = (type: (typeof BASE_DOCUMENT_TYPES)[number], typeId: string) => ({
    id: typeId,
    code: type.code,
    name: type.name,
    ...(type.localName ? { localName: type.localName } : {}),
    description: type.description,
    ...(type.examples ? { examples: [...type.examples] } : {}),
    category: type.category,
    ownerKind: type.ownerKind,
    requiresPeriod: type.requiresPeriod,
    ...(type.periodKind ? { periodKind: type.periodKind } : {}),
    requiresExpiry: type.requiresExpiry,
    isActive: true,
    displayOrder: type.displayOrder,
  });

  const documentTypes: Database["documentTypes"] = [
    ...BASE_DOCUMENT_TYPES.map((type) =>
      fromCatalogue(type, id("dty", BASE_DOCUMENT_TYPE_IDS[type.code] ?? 0)),
    ),
    // financial_statements is retained (not deleted, per BR-027's pattern) but
    // no longer generated — superseded by the two split-out, financial-year-
    // scoped types (Database/migrations/0011). It has no catalogue entry
    // because nothing may ask for it again.
    { id: id("dty", 10), code: "financial_statements", name: "Financial Statements", ownerKind: "organisation", requiresPeriod: true, isActive: false, displayOrder: 100 },
    // Ids continue from 20 so the eighteen above keep the ids everything else
    // already points at.
    ...ENGINE_DOCUMENT_TYPES.map((type, index) => fromCatalogue(type, id("dty", 20 + index))),
  ];

  /**
   * The rule pack, seeded exactly as Database/migrations/0022 seeds it.
   *
   * These are DEFAULTS. Everything below is editable from the Document Rules
   * screen — which is the milestone: what AOS asks for is data a business
   * user owns, not code a developer owns.
   */
  const documentRequirementRules: Database["documentRequirementRules"] =
    DEFAULT_REQUIREMENT_RULES.map((rule, index) => ({
      ...rule,
      id: id("drr", index + 1),
    }));

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

  // ---------------------------------------------------------------------
  // Bank & NBFC Catalogue (Milestone 8) — Database/migrations/0019, 0020.
  // Mirrors the DB seed: real Indian institutions, their real head offices,
  // and nothing else.
  //
  // What is deliberately absent, exactly as in the migration: relationship
  // managers (inventing the names of bank employees would put fictional
  // people in an operational contact list), branch addresses and phone
  // numbers, turnaround days, rates and limits — and every lender insight.
  // The insight table is the most valuable one in this milestone and it
  // starts empty on purpose: "excellent for textile businesses" is only
  // worth storing when it is Amaze's own observation, and a seeded one would
  // be an invented opinion attributed to the team.
  //
  // The four Madurai lenders seeded above (HDFC Bank, IIFL, LIC HFL,
  // Sundaram) stay exactly as they were — existing submissions point at
  // their branches. HDFC Bank and LIC Housing Finance are the same
  // institutions this catalogue would otherwise add, so they gain a profile
  // rather than a duplicate row, which is the whole reason lenders are
  // organisations (ADR-014).
  // ---------------------------------------------------------------------

  const lenderTypes: Database["lenderTypes"] = [
    { id: id("lty", 1), code: "public_sector_bank", name: "Public Sector Bank", description: "A commercial bank majority-owned by the Government of India. Broad product range, competitive rates, process-driven and usually slower.", isActive: true, displayOrder: 10 },
    { id: id("lty", 2), code: "private_sector_bank", name: "Private Sector Bank", description: "A privately-owned commercial bank. Faster decisions, wider risk appetite, generally priced above the public sector.", isActive: true, displayOrder: 20 },
    { id: id("lty", 3), code: "small_finance_bank", name: "Small Finance Bank", description: "Licensed to serve small businesses, micro enterprises and the unbanked. Small ticket sizes, local reach, higher rates.", isActive: true, displayOrder: 30 },
    { id: id("lty", 4), code: "regional_rural_bank", name: "Regional Rural Bank", description: "Sponsored by a commercial bank to serve a defined rural region. Priority-sector and agricultural lending.", isActive: true, displayOrder: 40 },
    { id: id("lty", 5), code: "cooperative_bank", name: "Cooperative Bank", description: "A member-owned bank under state or multi-state cooperative law. Strong local presence, narrower product range.", isActive: true, displayOrder: 50 },
    { id: id("lty", 6), code: "nbfc", name: "NBFC", description: "A non-banking financial company. Lends but takes no demand deposits. Flexible assessment, faster turnaround, higher rates.", isActive: true, displayOrder: 60 },
    { id: id("lty", 7), code: "housing_finance_company", name: "Housing Finance Company", description: "An NBFC specialising in housing finance. Home loans, loans against property, construction finance.", isActive: true, displayOrder: 70 },
  ];

  const lenderRelationshipRoles: Database["lenderRelationshipRoles"] = [
    { id: id("lrr", 1), code: "relationship_manager", name: "Relationship Manager", description: "The day-to-day contact for files lodged with this lender. The default.", isActive: true, displayOrder: 10 },
    { id: id("lrr", 2), code: "branch_manager", name: "Branch Manager", description: "Heads the branch. Usually the escalation, not the first call.", isActive: true, displayOrder: 20 },
    { id: id("lrr", 3), code: "credit_manager", name: "Credit Manager", description: "Assesses the file. Queries and conditions usually originate here.", isActive: true, displayOrder: 30 },
    { id: id("lrr", 4), code: "sales_manager", name: "Sales Manager", description: "Sourcing side. Owns targets, and often the one who agrees to look at a borderline case.", isActive: true, displayOrder: 40 },
    { id: id("lrr", 5), code: "operations_officer", name: "Operations Officer", description: "Processing and disbursement. Chased for sanction letters and disbursement dates.", isActive: true, displayOrder: 50 },
    { id: id("lrr", 6), code: "channel_manager", name: "Channel Manager", description: "Manages the lender's DSA and connector channel.", isActive: true, displayOrder: 60 },
  ];

  const submissionModes: Database["submissionModes"] = [
    { id: id("smd", 1), code: "branch_counter", name: "At the Branch", description: "A physical file handed over at the branch. Still the norm at most public sector banks.", isActive: true, displayOrder: 10 },
    { id: id("smd", 2), code: "email", name: "By Email", description: "A scanned set emailed to a credit desk or relationship manager.", isActive: true, displayOrder: 20 },
    { id: id("smd", 3), code: "partner_portal", name: "Lender Portal", description: "Logged through the lender's own partner or DSA portal.", isActive: true, displayOrder: 30 },
    { id: id("smd", 4), code: "connector_app", name: "Connector App", description: "Logged through the lender's mobile connector app.", isActive: true, displayOrder: 40 },
    { id: id("smd", 5), code: "rm_pickup", name: "Collected by the RM", description: "The relationship manager collects the file and lodges it internally.", isActive: true, displayOrder: 50 },
  ];

  const lenderInsightCategories: Database["lenderInsightCategories"] = [
    { id: id("lic", 1), code: "segment_fit", name: "Good Fit For", description: "Customer segments, trades or profiles this lender handles well. Experience, not a rule.", isActive: true, displayOrder: 10 },
    { id: id("lic", 2), code: "strength", name: "Known Strength", description: "What this lender is genuinely good at — pricing, speed, flexibility on a particular point.", isActive: true, displayOrder: 20 },
    { id: id("lic", 3), code: "limitation", name: "Known Limitation", description: "Where this lender is difficult, slow or unwilling. Worth knowing before lodging.", isActive: true, displayOrder: 30 },
    { id: id("lic", 4), code: "documentation_habit", name: "Documentation Habit", description: "What this lender routinely asks for beyond the standard set.", isActive: true, displayOrder: 40 },
    { id: id("lic", 5), code: "process_tip", name: "Process Tip", description: "How to get a file through faster. Practical, learned the hard way.", isActive: true, displayOrder: 50 },
    { id: id("lic", 6), code: "communication_preference", name: "Communication Preference", description: "How this lender or its managers prefer to be contacted and followed up.", isActive: true, displayOrder: 60 },
    { id: id("lic", 7), code: "rejection_pattern", name: "Rejection Pattern", description: "What this lender tends to decline. Distinct from the standardised rejection reason recorded against an actual rejected file (ADR-028).", isActive: true, displayOrder: 70 },
  ];

  /**
   * The institutions, as a table: internal code, name, type, the legacy
   * enum value, head office, service region, website, aliases, and — for the
   * two that need one — a note of record. Head offices are public record;
   * everything operational is left blank on purpose.
   */
  const institutionRows: Array<[
    string, string, string, "bank" | "nbfc" | "hfc", string, string, string | undefined,
    string[], string | undefined, boolean,
  ]> = [
    ["sbi", "State Bank of India", "public_sector_bank", "bank", "Mumbai", "Pan-India", "https://sbi.co.in", ["SBI"], undefined, true],
    ["indian_bank", "Indian Bank", "public_sector_bank", "bank", "Chennai", "Pan-India, strongest in Tamil Nadu", "https://indianbank.in", [], undefined, true],
    ["canara_bank", "Canara Bank", "public_sector_bank", "bank", "Bengaluru", "Pan-India, strongest in South India", "https://canarabank.com", [], undefined, true],
    ["bank_of_baroda", "Bank of Baroda", "public_sector_bank", "bank", "Vadodara", "Pan-India", "https://bankofbaroda.in", ["BoB"], undefined, true],
    ["union_bank", "Union Bank of India", "public_sector_bank", "bank", "Mumbai", "Pan-India", "https://unionbankofindia.co.in", [], undefined, true],
    ["pnb", "Punjab National Bank", "public_sector_bank", "bank", "New Delhi", "Pan-India, strongest in North India", "https://pnbindia.in", ["PNB"], undefined, true],
    ["iob", "Indian Overseas Bank", "public_sector_bank", "bank", "Chennai", "Pan-India, strongest in Tamil Nadu", "https://iob.in", ["IOB"], undefined, true],
    ["icici_bank", "ICICI Bank", "private_sector_bank", "bank", "Mumbai", "Pan-India", "https://icicibank.com", [], "Registered office is in Vadodara; the corporate office and the lending business are run from Mumbai.", true],
    ["axis_bank", "Axis Bank", "private_sector_bank", "bank", "Mumbai", "Pan-India", "https://axisbank.com", [], "Registered office is in Ahmedabad; the corporate office is in Mumbai.", true],
    ["kotak_bank", "Kotak Mahindra Bank", "private_sector_bank", "bank", "Mumbai", "Pan-India", "https://kotak.com", [], undefined, true],
    ["federal_bank", "Federal Bank", "private_sector_bank", "bank", "Aluva", "Kerala and Tamil Nadu, plus metros", "https://federalbank.co.in", [], undefined, true],
    ["south_indian_bank", "South Indian Bank", "private_sector_bank", "bank", "Thrissur", "Kerala and Tamil Nadu", "https://southindianbank.com", [], undefined, true],
    ["csb_bank", "CSB Bank", "private_sector_bank", "bank", "Thrissur", "Kerala and Tamil Nadu", "https://csb.co.in", [], undefined, true],
    ["tmb", "Tamilnad Mercantile Bank", "private_sector_bank", "bank", "Thoothukudi", "Tamil Nadu", "https://tmb.in", ["TMB"], undefined, true],
    ["kvb", "Karur Vysya Bank", "private_sector_bank", "bank", "Karur", "Tamil Nadu", "https://kvb.co.in", ["KVB"], undefined, true],
    ["city_union_bank", "City Union Bank", "private_sector_bank", "bank", "Kumbakonam", "Tamil Nadu", "https://cityunionbank.com", ["CUB"], undefined, true],
    // Legacy reference. Amalgamated into DBS Bank India on 27 November 2020,
    // so it is seeded inactive — old cases naming it still resolve, and
    // nobody can pick it for a new one (the never-delete convention, 0014).
    ["lvb", "Lakshmi Vilas Bank", "private_sector_bank", "bank", "Chennai", "Tamil Nadu", undefined, ["LVB"], "LEGACY REFERENCE ONLY. Amalgamated into DBS Bank India Ltd on 27 November 2020 and no longer exists as a lender.", false],
    ["bajaj_finance", "Bajaj Finance", "nbfc", "nbfc", "Pune", "Pan-India", "https://bajajfinserv.in", [], undefined, true],
    ["tata_capital", "Tata Capital", "nbfc", "nbfc", "Mumbai", "Pan-India", "https://tatacapital.com", [], undefined, true],
    ["aditya_birla_finance", "Aditya Birla Finance", "nbfc", "nbfc", "Mumbai", "Pan-India", "https://adityabirlacapital.com", [], undefined, true],
    ["chola", "Cholamandalam Investment and Finance Company", "nbfc", "nbfc", "Chennai", "Pan-India, strongest in South India", "https://cholamandalam.com", ["Chola", "Cholamandalam Finance"], undefined, true],
    ["shriram_finance", "Shriram Finance", "nbfc", "nbfc", "Chennai", "Pan-India, strongest in South India", "https://shriramfinance.in", [], undefined, true],
    ["lt_finance", "L&T Finance", "nbfc", "nbfc", "Mumbai", "Pan-India", "https://ltfs.com", ["LTF"], undefined, true],
    ["poonawalla_fincorp", "Poonawalla Fincorp", "nbfc", "nbfc", "Pune", "Pan-India", "https://poonawallafincorp.com", [], undefined, true],
    ["pnb_hfl", "PNB Housing Finance", "housing_finance_company", "hfc", "New Delhi", "Pan-India", "https://pnbhousing.com", ["PNB HFL"], undefined, true],
    ["aavas", "Aavas Financiers", "housing_finance_company", "hfc", "Jaipur", "Pan-India, semi-urban and rural focus", "https://aavas.in", [], undefined, true],
    ["aptus", "Aptus Value Housing Finance India", "housing_finance_company", "hfc", "Chennai", "South India, semi-urban and rural", "https://aptusindia.com", ["Aptus"], undefined, true],
    // Milestone 10 (Database/migrations/0025) — the institutions the
    // Coimbatore market has and Milestone 8 did not catalogue. Small finance
    // banks and co-operative banks were both named in the brief and both
    // genuinely absent; neither is a rounding error here. An SFB is often the
    // only lender that will look at a small trader with two patchy years of
    // banking, and the district central co-operative bank is a real
    // counterparty for agricultural and small business files in this belt.
    ["bank_of_india", "Bank of India", "public_sector_bank", "bank", "Mumbai", "Pan-India", "https://bankofindia.co.in", ["BOI"], undefined, true],
    ["central_bank", "Central Bank of India", "public_sector_bank", "bank", "Mumbai", "Pan-India", "https://centralbankofindia.co.in", ["CBI"], undefined, true],
    ["indusind_bank", "IndusInd Bank", "private_sector_bank", "bank", "Mumbai", "Pan-India", "https://indusind.com", [], undefined, true],
    ["idfc_first", "IDFC FIRST Bank", "private_sector_bank", "bank", "Mumbai", "Pan-India", "https://idfcfirstbank.com", ["IDFC"], undefined, true],
    ["karnataka_bank", "Karnataka Bank", "private_sector_bank", "bank", "Mangaluru", "Karnataka and Tamil Nadu", "https://karnatakabank.com", [], undefined, true],
    ["equitas_sfb", "Equitas Small Finance Bank", "small_finance_bank", "bank", "Chennai", "Tamil Nadu and South India", "https://equitasbank.com", ["Equitas"], "Converted from Equitas Micro Finance. Strong in small-ticket business and used commercial vehicle lending across western Tamil Nadu.", true],
    ["ujjivan_sfb", "Ujjivan Small Finance Bank", "small_finance_bank", "bank", "Bengaluru", "Pan-India, South India focus", "https://ujjivansfb.in", ["Ujjivan"], undefined, true],
    ["esaf_sfb", "ESAF Small Finance Bank", "small_finance_bank", "bank", "Thrissur", "Kerala and Tamil Nadu", "https://esafbank.com", ["ESAF"], undefined, true],
    ["au_sfb", "AU Small Finance Bank", "small_finance_bank", "bank", "Jaipur", "Pan-India", "https://aubank.in", ["AU Bank"], undefined, true],
    ["jana_sfb", "Jana Small Finance Bank", "small_finance_bank", "bank", "Bengaluru", "Pan-India, South India focus", "https://janabank.com", ["Jana Bank"], undefined, true],
    ["cdcc_bank", "Coimbatore District Central Co-operative Bank", "cooperative_bank", "bank", "Coimbatore", "Coimbatore district", undefined, ["CDCC Bank"], "The district central co-operative bank for Coimbatore. Agricultural, jewel and small business lending, and for many rural files in the district the first counterparty rather than an afterthought.", true],
    ["cccb", "Coimbatore City Co-operative Bank", "cooperative_bank", "bank", "Coimbatore", "Coimbatore city", undefined, [], undefined, true],
    ["muthoot_finance", "Muthoot Finance", "nbfc", "nbfc", "Kochi", "Pan-India", "https://muthootfinance.com", ["Muthoot"], "Predominantly gold loans. In this market that is a mainstream short-term funding route, not a fringe one — which is why it is catalogued rather than left out.", true],
    ["manappuram", "Manappuram Finance", "nbfc", "nbfc", "Thrissur", "Pan-India, South India focus", "https://manappuram.com", ["Manappuram"], undefined, true],
    ["hinduja_leyland", "Hinduja Leyland Finance", "nbfc", "nbfc", "Chennai", "Pan-India, South India focus", "https://hindujaleylandfinance.com", ["HLF"], "Commercial vehicle and construction equipment finance. Relevant here because Coimbatore's transport and engineering trade is a recurring source of files.", true],
    ["repco", "Repco Home Finance", "housing_finance_company", "hfc", "Chennai", "Tamil Nadu and South India", "https://repcohome.com", ["Repco"], "Tamil Nadu focused, and long-established with self-employed and semi-formal-income borrowers — the profile most often turned away by a bank.", true],
    ["can_fin", "Can Fin Homes", "housing_finance_company", "hfc", "Bengaluru", "South India", "https://canfinhomes.com", ["CanFin"], undefined, true],
    ["sundaram_home", "Sundaram Home Finance", "housing_finance_company", "hfc", "Chennai", "South India", "https://sundaramhome.in", [], "The housing arm of the Sundaram Finance group. A separate regulated entity from Sundaram Finance, which is already catalogued — two institutions, not one with two names.", true],
    ["home_first", "Home First Finance Company India", "housing_finance_company", "hfc", "Mumbai", "Pan-India, affordable housing", "https://homefirstindia.com", ["Home First"], undefined, true],
    ["india_shelter", "India Shelter Finance Corporation", "housing_finance_company", "hfc", "Gurugram", "Pan-India, affordable housing", "https://indiashelter.in", ["India Shelter"], undefined, true],
    ["bajaj_housing", "Bajaj Housing Finance", "housing_finance_company", "hfc", "Pune", "Pan-India", "https://bajajhousingfinance.in", ["Bajaj HFL"], "A separate housing finance company within the Bajaj group. Bajaj Finance, already catalogued, is the NBFC — they are different lenders with different files.", true],
  ];

  /**
   * Which Coimbatore localities each lender is present in (Milestone 10,
   * Database/migrations/0025).
   *
   * Milestone 8 gave every lender one placeholder branch called
   * "<Bank> — Coimbatore". That was honest for a milestone with no
   * branch-level brief, and useless to somebody choosing where to lodge a
   * file: the branch IS the counterparty (ADR-015).
   *
   * WHAT THIS CLAIMS: that a lender has a presence in a locality. These are
   * the city's actual banking areas, and networks of the size these
   * institutions operate cover them. A starting list for the office to
   * correct, not a survey.
   *
   * WHAT IT STILL REFUSES, exactly where Milestone 8 drew the line: street
   * addresses, IFSC codes, phone numbers, branch email addresses, and every
   * named human being. A blank field is a prompt; a plausible wrong one is a
   * trap, because nobody checks the value that looks right.
   */
  const COIMBATORE_BRANCHES: Record<string, string[]> = {
    // Public sector. Large networks — these are the localities a file is
    // realistically lodged at, not the whole branch list.
    sbi: ["RS Puram", "Gandhipuram", "Race Course", "Peelamedu", "Saibaba Colony", "Singanallur", "Town Hall"],
    indian_bank: ["RS Puram", "Gandhipuram", "Town Hall", "Peelamedu", "Saibaba Colony", "Ukkadam", "Saravanampatti"],
    canara_bank: ["RS Puram", "Gandhipuram", "Peelamedu", "Saibaba Colony", "Singanallur", "Thudiyalur"],
    bank_of_baroda: ["RS Puram", "Gandhipuram", "Peelamedu", "Singanallur"],
    union_bank: ["RS Puram", "Gandhipuram", "Town Hall", "Peelamedu"],
    pnb: ["Gandhipuram", "RS Puram", "Peelamedu"],
    iob: ["RS Puram", "Gandhipuram", "Town Hall", "Ukkadam", "Peelamedu", "Saibaba Colony"],
    bank_of_india: ["Gandhipuram", "RS Puram", "Peelamedu"],
    central_bank: ["Gandhipuram", "RS Puram"],
    // Private sector. Concentrated in the commercial and IT belts — Race
    // Course for corporate, Peelamedu and Saravanampatti for the Avinashi
    // Road corridor.
    hdfc_bank: ["RS Puram", "Race Course", "Peelamedu", "Saravanampatti", "Gandhipuram", "Saibaba Colony"],
    icici_bank: ["RS Puram", "Race Course", "Peelamedu", "Saravanampatti", "Gandhipuram"],
    axis_bank: ["RS Puram", "Race Course", "Peelamedu", "Saravanampatti"],
    kotak_bank: ["RS Puram", "Race Course", "Peelamedu"],
    indusind_bank: ["RS Puram", "Race Course", "Peelamedu"],
    idfc_first: ["RS Puram", "Race Course"],
    federal_bank: ["RS Puram", "Gandhipuram", "Peelamedu", "Saibaba Colony"],
    south_indian_bank: ["RS Puram", "Gandhipuram", "Peelamedu"],
    csb_bank: ["RS Puram", "Gandhipuram", "Town Hall"],
    tmb: ["RS Puram", "Gandhipuram", "Town Hall", "Ukkadam", "Peelamedu"],
    kvb: ["RS Puram", "Gandhipuram", "Town Hall", "Peelamedu", "Saibaba Colony"],
    city_union_bank: ["RS Puram", "Gandhipuram", "Town Hall", "Ukkadam"],
    karnataka_bank: ["RS Puram", "Gandhipuram"],
    // Small finance banks. Weighted towards the trading and industrial areas
    // — Ukkadam, Town Hall, Singanallur — which is where their borrowers are.
    equitas_sfb: ["Gandhipuram", "RS Puram", "Ukkadam", "Singanallur", "Peelamedu"],
    ujjivan_sfb: ["Gandhipuram", "Ukkadam", "Singanallur"],
    esaf_sfb: ["Gandhipuram", "Ukkadam"],
    au_sfb: ["RS Puram", "Peelamedu", "Gandhipuram"],
    jana_sfb: ["Gandhipuram", "Ukkadam"],
    // Co-operative banks. Old city and market areas.
    cdcc_bank: ["Town Hall", "Gandhipuram", "Ukkadam"],
    cccb: ["Town Hall", "Ukkadam"],
    // NBFCs. Race Course for the corporate offices; the gold loan lenders
    // spread wide across residential and market localities, because that is
    // what a gold loan branch network is.
    bajaj_finance: ["Race Course", "Peelamedu", "Gandhipuram"],
    tata_capital: ["Race Course", "Peelamedu"],
    aditya_birla_finance: ["Race Course", "Peelamedu"],
    chola: ["Race Course", "Gandhipuram", "Singanallur"],
    shriram_finance: ["Gandhipuram", "Singanallur", "Ukkadam", "Peelamedu"],
    sundaram_finance: ["Race Course", "Gandhipuram", "Peelamedu"],
    lt_finance: ["Race Course", "Peelamedu"],
    poonawalla_fincorp: ["Race Course"],
    muthoot_finance: ["Gandhipuram", "Town Hall", "Ukkadam", "RS Puram", "Saibaba Colony", "Singanallur", "Thudiyalur"],
    manappuram: ["Gandhipuram", "Town Hall", "Ukkadam", "RS Puram", "Singanallur"],
    hinduja_leyland: ["Race Course", "Singanallur"],
    // Housing finance. The affordable-housing lenders sit in the growth
    // localities — Kuniyamuthur, Thudiyalur, Saravanampatti — which is where
    // the self-construction and plot-purchase files come from.
    lic_hfl: ["Race Course", "RS Puram", "Peelamedu"],
    pnb_hfl: ["Race Course", "Peelamedu"],
    iifl_home_finance: ["Gandhipuram", "Peelamedu"],
    aavas: ["Gandhipuram", "Thudiyalur", "Kuniyamuthur"],
    aptus: ["Gandhipuram", "Kuniyamuthur", "Thudiyalur", "Singanallur"],
    repco: ["RS Puram", "Gandhipuram", "Peelamedu", "Kuniyamuthur"],
    can_fin: ["RS Puram", "Peelamedu", "Saravanampatti"],
    sundaram_home: ["Race Course", "RS Puram", "Peelamedu"],
    home_first: ["Gandhipuram", "Kuniyamuthur", "Saravanampatti"],
    india_shelter: ["Gandhipuram", "Thudiyalur"],
    bajaj_housing: ["Race Course", "Peelamedu"],
  };

  const BRANCH_SEED_NOTE =
    "Locality recorded from the Coimbatore catalogue. The street address, " +
    "phone, email and IFSC are deliberately not seeded — fill them in from " +
    "the branch you actually deal with.";

  const lenderProfiles: Database["lenderProfiles"] = [];
  const bankBranches: Database["bankBranches"] = [];

  /** Adds a profile to an organisation that already exists in the seed. */
  const profileFor = (
    organisationId: string,
    code: string,
    typeCode: string,
    legacy: "bank" | "nbfc" | "hfc",
    headOffice: string,
    region: string,
    website: string | undefined,
    order: number,
    notes?: string,
  ): void => {
    lenderProfiles.push({
      organisationId,
      lenderTypeId: idOf(lenderTypes, typeCode),
      lenderType: legacy,
      code,
      headOfficeCity: headOffice,
      primaryServiceRegion: region,
      isOnPanel: true,
      displayOrder: order,
      ...(website ? { websiteUrl: website } : {}),
      ...(notes ? { notes } : {}),
    });
  };

  // The four lenders seeded above for the Madurai cases, given the profile
  // this milestone adds. Not duplicated as new rows: HDFC Bank is HDFC Bank
  // (ADR-014).
  profileFor(id("org", 1), "hdfc_bank", "private_sector_bank", "bank", "Mumbai", "Pan-India", "https://hdfcbank.com", 110,
    "HDFC Ltd merged into HDFC Bank with effect from 1 July 2023. What the market still calls \"HDFC Home Loans\" is this institution — there is deliberately no separate housing finance entity for it in this catalogue.");
  profileFor(id("org", 3), "iifl_home_finance", "housing_finance_company", "hfc", "Mumbai", "Pan-India", "https://iiflhomeloans.com", 450);
  profileFor(id("org", 5), "lic_hfl", "housing_finance_company", "hfc", "Mumbai", "Pan-India", "https://lichousing.com", 410);
  profileFor(id("org", 7), "sundaram_finance", "nbfc", "nbfc", "Chennai", "South India", "https://sundaramfinance.in", 380);

  // The existing Madurai branches, given the branch extension. Madurai is
  // outside the seeded Coimbatore-first geography (Database/migrations/0014),
  // so their district and city are left unset rather than forced into a
  // district they are not in.
  for (const branchId of [id("org", 2), id("org", 4), id("org", 6), id("org", 8)]) {
    bankBranches.push({ organisationId: branchId, operationalStatus: "operational", displayOrder: 10 });
  }

  // One running counter across every institution's branches: a lender has as
  // many as it has, and the old one-per-lender id arithmetic could not
  // express that.
  let branchSeq = 0;

  /**
   * The Coimbatore branches of one institution (Milestone 10).
   *
   * Localities, not one placeholder. The branch is the counterparty a file
   * physically goes to (ADR-015), so "— Coimbatore" is not an address anybody
   * can lodge at. The locality is claimed; the street, the phone and the
   * email are not, and stay empty until the office fills them in.
   */
  const addCoimbatoreBranches = (orgId: string, name: string, code: string): void => {
    for (const locality of COIMBATORE_BRANCHES[code] ?? ["Coimbatore"]) {
      const branchId = id("org", 200 + branchSeq++);
      organisations.push({
        id: branchId,
        canonicalName: `${name} — ${locality}`,
        roles: ["branch"],
        industry: "Banking and Finance",
        city: "Coimbatore",
        parentOrganisationId: orgId,
        aliases: [],
      });
      bankBranches.push({
        organisationId: branchId,
        cityId: idOf(cities, "coimbatore"),
        districtId: idOf(districts, "coimbatore"),
        operationalStatus: "operational",
        displayOrder: bankBranches.length * 10,
        notes: BRANCH_SEED_NOTE,
      });
    }
  };

  // The four lenders that were already here for the Madurai cases get their
  // Coimbatore branches too. Easy to miss, and the omission would be
  // invisible: HDFC Bank would simply have no Coimbatore branch to lodge at,
  // on the screen whose entire purpose is choosing one.
  addCoimbatoreBranches(id("org", 1), "HDFC Bank", "hdfc_bank");
  addCoimbatoreBranches(id("org", 3), "IIFL Home Finance", "iifl_home_finance");
  addCoimbatoreBranches(id("org", 5), "LIC Housing Finance", "lic_hfl");
  addCoimbatoreBranches(id("org", 7), "Sundaram Finance", "sundaram_finance");

  institutionRows.forEach((row, index) => {
    const [code, name, typeCode, legacy, headOffice, region, website, aliases, notes, isActive] = row;
    const orgId = id("org", 100 + index);
    organisations.push({
      id: orgId,
      canonicalName: name,
      roles: ["lender"],
      industry: "Banking and Finance",
      city: headOffice,
      aliases,
      // Inactive means the institution no longer exists — which is true of
      // exactly one row here, and is a different fact from being off panel.
      isActive,
    });
    lenderProfiles.push({
      organisationId: orgId,
      lenderTypeId: idOf(lenderTypes, typeCode),
      lenderType: legacy,
      code,
      headOfficeCity: headOffice,
      primaryServiceRegion: region,
      isOnPanel: isActive,
      displayOrder: (index + 1) * 10,
      ...(website ? { websiteUrl: website } : {}),
      ...(notes ? { notes } : {}),
    });

    // An institution that no longer exists gets no branch to lodge at, which
    // is the point of carrying it at all (Lakshmi Vilas Bank, ADR-034).
    if (!isActive) return;
    addCoimbatoreBranches(orgId, name, code);
  });

  /**
   * Supported products — only what is true by the nature of the institution.
   *
   * A housing finance company does home loans and loans against property:
   * that is what the licence is for. A universal commercial bank does home
   * loans, LAP, business term loans and working capital: that is what a
   * full-service bank is. Anything finer — who does used commercial
   * vehicles, who will look at an unsecured business loan above fifty lakh —
   * is real knowledge that varies by year and by branch, and it belongs to
   * the office, entered on the screen.
   */
  const BANK_PRODUCT_CODES = ["hl_purchase", "hl_self_construct", "hl_balance_transfer", "lap", "bl_term_loan", "bl_working_capital"];
  const HFC_PRODUCT_CODES = ["hl_purchase", "hl_self_construct", "hl_plot_construction", "hl_improvement", "hl_balance_transfer", "hl_top_up", "lap"];

  const bankProducts: Database["bankProducts"] = [];
  let bankProductSeq = 0;
  for (const profile of lenderProfiles) {
    const typeCode = lenderTypes.find((t) => t.id === profile.lenderTypeId)?.code;
    // A small finance bank and a co-operative bank are universal banks for
    // this purpose — narrower in appetite, not in licence — so they get the
    // bank set. An NBFC's book varies far too much to assert anything, so
    // nothing is asserted for one.
    const productCodes =
      typeCode === "public_sector_bank" ||
      typeCode === "private_sector_bank" ||
      typeCode === "small_finance_bank" ||
      typeCode === "cooperative_bank"
        ? BANK_PRODUCT_CODES
        : typeCode === "housing_finance_company"
          ? HFC_PRODUCT_CODES
          : [];
    for (const productCode of productCodes) {
      const product = loanProducts.find((p) => p.code === productCode);
      if (!product) continue;
      bankProducts.push({
        id: id("bpr", ++bankProductSeq),
        organisationId: profile.organisationId,
        loanProductId: product.id,
        name: product.name ?? product.variant,
        isActive: true,
        displayOrder: product.displayOrder,
        notes: "Recorded because an institution of this kind offers this product. Replace the name with the lender's own if it has one, and add limits and rates as the office learns them.",
      });
    }
  }

  // Empty on purpose — see this section's header comment.
  const bankContacts: Database["bankContacts"] = [];
  const lenderSubmissionRules: Database["lenderSubmissionRules"] = [];
  const lenderInsights: Database["lenderInsights"] = [];

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
      // A GST-registered working-capital case: the fact that drives the GST
      // certificate and GST returns requirements existing at all (Milestone 9).
      isGstRegistered: true, hasExistingObligations: true,
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

  /**
   * The snapshot every submission carries (Milestone 10, ADR-036).
   *
   * These six predate the workflow that captures one, so they are
   * RECONSTRUCTED from the branch as it stands — which is exactly what
   * Database/migrations/0024's backfill does to the real rows, and why
   * `snapshotTakenAt` is deliberately left off them. A reconstruction is not
   * a record, and anything reporting on historical accuracy has to be able to
   * tell the two apart.
   */
  const reconstructed = (branchOrganisationId: string) => {
    const branch = organisations.find((org) => org.id === branchOrganisationId);
    const institution = organisations.find((org) => org.id === branch?.parentOrganisationId);
    return {
      branchOrganisationId,
      ...(institution ? { institutionOrganisationId: institution.id } : {}),
      ...(institution ? { bankNameAtSubmission: institution.canonicalName } : {}),
      ...(branch ? { branchNameAtSubmission: branch.canonicalName } : {}),
      ...(branch?.city ? { branchCityAtSubmission: branch.city } : {}),
    };
  };

  const submissions: Database["submissions"] = [
    // Case 1: sanctioned at one bank, rejected at another. Both true at once.
    { id: id("sub", 1), caseId: id("cas", 1), ...reconstructed(id("org", 2)), status: "sanctioned", submittedAt: daysAgo(38), loginFeeAmount: 5900, bankReferenceNumber: "HDFC/MDU/2026/8841", createdAt: daysAgo(40) },
    { id: id("sub", 2), caseId: id("cas", 1), ...reconstructed(id("org", 4)), status: "rejected", submittedAt: daysAgo(37), rejectionReasonId: id("rej", 3), bankReasonText: "FOIR exceeds 55% post proposed EMI", createdAt: daysAgo(39) },
    { id: id("sub", 3), caseId: id("cas", 1), ...reconstructed(id("org", 6)), status: "under_process", submittedAt: daysAgo(20), createdAt: daysAgo(21) },
    // Case 3
    { id: id("sub", 4), caseId: id("cas", 3), ...reconstructed(id("org", 8)), status: "query_raised", submittedAt: daysAgo(14), createdAt: daysAgo(15) },
    // Case 8 — disbursed
    { id: id("sub", 5), caseId: id("cas", 8), ...reconstructed(id("org", 2)), status: "disbursed", submittedAt: daysAgo(120), loginFeeAmount: 5900, createdAt: daysAgo(122) },
    // Case 6 — lost after sanction
    { id: id("sub", 6), caseId: id("cas", 6), ...reconstructed(id("org", 2)), status: "sanctioned", submittedAt: daysAgo(80), createdAt: daysAgo(82) },
  ];

  /**
   * Empty, on the same principle that keeps `bankContacts` empty.
   *
   * A recipient is a real banker's real email address. Seeding one would put
   * a fabricated address in front of a user at the exact moment they are
   * about to send a customer's file to it — which is worse than an invented
   * phone number, because the file goes.
   */
  const submissionRecipients: Database["submissionRecipients"] = [];

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
    lenderTypes, lenderRelationshipRoles, submissionModes, lenderInsightCategories,
    lenderProfiles, bankBranches, bankContacts, bankProducts,
    lenderSubmissionRules, lenderInsights,
    cases, caseParties, caseProperties, documents,
    requirements: [], documentRequirementRules,
    submissions, submissionRecipients, offers, communications, notes, tasks, events,
    caseNumberSequence: { [year]: 47 },
  };
}
