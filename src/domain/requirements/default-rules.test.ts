/**
 * The default rule pack, tested as business behaviour rather than as data.
 *
 * Each test below is a sentence an office user would recognise. If one of
 * them fails, a real checklist is wrong — which is a different and more
 * serious thing than a unit test failing.
 */

import { describe, expect, it } from "vitest";

import { allDocumentTypeCodes, isFinancialYearScoped } from "./document-catalogue.js";
import {
  DEFAULT_REQUIREMENT_RULES,
  activeRulesAskingForNonCustomerDocuments,
  defaultRuleDocumentTypeCodes,
} from "./default-rules.js";
import { evaluateRules, type CaseFacts, type PartyFacts } from "./rules.js";

function individual(overrides: Partial<PartyFacts> = {}): PartyFacts {
  return {
    casePartyId: "cpt_applicant",
    role: "applicant",
    kind: "person",
    isPrimary: true,
    borrowerTypeCode: "resident_individual",
    ...overrides,
  };
}

function firm(overrides: Partial<PartyFacts> = {}): PartyFacts {
  return {
    casePartyId: "cpt_firm",
    role: "borrower_firm",
    kind: "organisation",
    borrowerTypeCode: "non_individual",
    ...overrides,
  };
}

function evaluate(facts: Partial<CaseFacts> & Pick<CaseFacts, "productCode">): string[] {
  return evaluateRules(DEFAULT_REQUIREMENT_RULES, {
    parties: [individual()],
    properties: [],
    ...facts,
  }).map((row) => row.documentTypeCode);
}

describe("the default pack — KYC", () => {
  it("asks every individual on the file for PAN, Aadhaar, address proof and a photograph", () => {
    const asked = evaluate({
      productCode: "pl",
      customerProductCode: "personal_loan",
      parties: [individual(), individual({ casePartyId: "cpt_co", role: "co_applicant" })],
    });

    expect(asked.filter((code) => code === "pan_card")).toHaveLength(2);
    expect(asked).toContain("aadhaar_card");
    expect(asked).toContain("address_proof");
    expect(asked).toContain("photograph");
  });

  it("KYCs a guarantor like anyone else, but does not underwrite them like an applicant", () => {
    const rows = evaluateRules(DEFAULT_REQUIREMENT_RULES, {
      productCode: "hl_purchase",
      customerProductCode: "home_loan",
      parties: [individual(), individual({ casePartyId: "cpt_g", role: "guarantor" })],
      properties: [],
    });

    const guarantorDocs = rows
      .filter((row) => row.casePartyId === "cpt_g")
      .map((row) => row.documentTypeCode);

    expect(guarantorDocs).toContain("pan_card");
    expect(guarantorDocs).toContain("credit_bureau_consent");
    expect(guarantorDocs).not.toContain("salary_slip");
  });
});

describe("the default pack — income by employment type", () => {
  it("asks a salaried applicant for payslips and Form 16, never for an ITR", () => {
    const asked = evaluate({
      productCode: "hl_purchase",
      customerProductCode: "home_loan",
      parties: [individual({ employmentTypeCode: "salaried" })],
    });

    expect(asked).toContain("salary_slip");
    expect(asked).toContain("form_16");
    expect(asked).toContain("bank_statement");
    expect(asked).not.toContain("itr");
  });

  it("asks a self-employed applicant for an ITR, never for payslips", () => {
    const asked = evaluate({
      productCode: "hl_purchase",
      customerProductCode: "home_loan",
      parties: [individual({ employmentTypeCode: "self_employed" })],
    });

    expect(asked).toContain("itr");
    expect(asked).toContain("bank_statement");
    expect(asked).not.toContain("salary_slip");
    expect(asked).not.toContain("form_16");
  });

  it("asks a professional-loan applicant for their qualification certificate", () => {
    const asked = evaluate({
      productCode: "pl_professional",
      customerProductCode: "personal_loan",
      parties: [individual({ employmentTypeCode: "self_employed" })],
    });

    expect(asked).toContain("qualification_proof");
  });

  it("asks three financial years of business ITR and one of banking", () => {
    const rows = evaluateRules(DEFAULT_REQUIREMENT_RULES, {
      productCode: "bl_unsecured",
      customerProductCode: "business_loan",
      parties: [individual({ employmentTypeCode: "business_owner" })],
      properties: [],
    });

    // A business loan asks for the BUSINESS return (org_itr); the personal
    // ITR rule stands down there so one filing is not named twice.
    expect(rows.find((row) => row.documentTypeCode === "org_itr")?.financialYears).toBe(3);
    expect(rows.find((row) => row.documentTypeCode === "bank_statement")?.financialYears).toBe(1);
  });
});

describe("the default pack — a gold loan is documented by the security", () => {
  it("asks for KYC and the appraisal, and for no income proof at all", () => {
    const asked = evaluate({
      productCode: "gl_gold",
      customerProductCode: "gold_loan",
      parties: [individual({ employmentTypeCode: "salaried" })],
    });

    expect(asked).toContain("pan_card");
    expect(asked).toContain("gold_appraisal_note");
    expect(asked).not.toContain("salary_slip");
    expect(asked).not.toContain("form_16");
    expect(asked).not.toContain("itr");
    expect(asked).not.toContain("bank_statement");
  });
});

describe("the default pack — business constitution drives business paperwork", () => {
  it("asks a partnership for its deed and a private limited for incorporation, MOA/AOA and a board resolution", () => {
    const partnership = evaluate({
      productCode: "bl_term_loan",
      customerProductCode: "business_loan",
      parties: [individual({ employmentTypeCode: "business_owner" }), firm({ businessConstitutionCode: "partnership" })],
    });

    expect(partnership).toContain("partnership_deed");
    expect(partnership).not.toContain("moa_aoa");

    const company = evaluate({
      productCode: "bl_term_loan",
      customerProductCode: "business_loan",
      parties: [
        individual({ employmentTypeCode: "business_owner" }),
        firm({ businessConstitutionCode: "private_limited" }),
      ],
    });

    expect(company).toContain("certificate_of_incorporation");
    expect(company).toContain("moa_aoa");
    expect(company).toContain("board_resolution");
    expect(company).toContain("audit_report");
    expect(company).not.toContain("partnership_deed");
  });

  it("does not ask an unaudited proprietorship for an audit report", () => {
    const asked = evaluate({
      productCode: "bl_mudra",
      customerProductCode: "business_loan",
      parties: [
        individual({ employmentTypeCode: "business_owner" }),
        firm({ businessConstitutionCode: "proprietorship" }),
      ],
    });

    expect(asked).toContain("org_pan");
    expect(asked).not.toContain("audit_report");
  });
});

describe("the default pack — GST depends on registration, not on the product", () => {
  it("asks for GST returns only when the business is registered", () => {
    const unregistered = evaluate({
      productCode: "bl_unsecured",
      customerProductCode: "business_loan",
      isGstRegistered: false,
      parties: [individual({ employmentTypeCode: "business_owner" }), firm()],
    });

    expect(unregistered).not.toContain("gst_certificate");
    expect(unregistered).not.toContain("gst_returns");

    const registered = evaluate({
      productCode: "bl_unsecured",
      customerProductCode: "business_loan",
      isGstRegistered: true,
      parties: [individual({ employmentTypeCode: "business_owner" }), firm()],
    });

    expect(registered).toContain("gst_certificate");
    expect(registered).toContain("gst_returns");
  });
});

describe("the default pack — property", () => {
  it("asks for nothing property-related until a property is on the file", () => {
    const noProperty = evaluate({ productCode: "hl_purchase", customerProductCode: "home_loan" });

    expect(noProperty).not.toContain("sale_deed");
    expect(noProperty).not.toContain("encumbrance_cert");
    expect(noProperty).not.toContain("patta_chitta");
  });

  it("asks for the Tamil Nadu core — patta/chitta, parent document and EC — once one exists", () => {
    const asked = evaluate({
      productCode: "hl_purchase",
      customerProductCode: "home_loan",
      properties: [
        { casePropertyId: "cpr_1", role: "purchase", propertyTypeCode: "independent_house" },
      ],
    });

    expect(asked).toContain("patta_chitta");
    expect(asked).toContain("parent_document");
    expect(asked).toContain("encumbrance_cert");
    expect(asked).toContain("sale_agreement");
  });

  it("does not ask for patta on an apartment held on undivided share", () => {
    const asked = evaluate({
      productCode: "hl_purchase",
      customerProductCode: "home_loan",
      properties: [{ casePropertyId: "cpr_1", role: "purchase", propertyTypeCode: "apartment" }],
    });

    expect(asked).not.toContain("patta_chitta");
    expect(asked).toContain("sale_deed");
  });

  it("holds the valuation and legal opinion back until a lender is being approached", () => {
    const rows = evaluateRules(DEFAULT_REQUIREMENT_RULES, {
      productCode: "lap",
      customerProductCode: "lap",
      parties: [individual({ employmentTypeCode: "business_owner" })],
      properties: [{ casePropertyId: "cpr_1", role: "collateral", propertyTypeCode: "commercial" }],
    });

    expect(rows.find((r) => r.documentTypeCode === "valuation_report")?.applicableFromStage).toBe(
      "ready_for_submission",
    );
    expect(rows.find((r) => r.documentTypeCode === "legal_opinion")?.applicableFromStage).toBe(
      "ready_for_submission",
    );
  });
});

describe("the default pack — construction", () => {
  it("asks for an estimate on a construction loan and for nothing on a plot purchase", () => {
    const construction = evaluate({
      productCode: "hl_self_construct",
      customerProductCode: "home_loan",
      properties: [{ casePropertyId: "cpr_1", role: "collateral", propertyTypeCode: "plot" }],
    });
    expect(construction).toContain("construction_estimate");

    const plot = evaluate({
      productCode: "hl_plot_purchase",
      customerProductCode: "home_loan",
      properties: [{ casePropertyId: "cpr_1", role: "purchase", propertyTypeCode: "plot" }],
    });
    expect(plot).not.toContain("construction_estimate");
    expect(plot).toContain("layout_approval");
  });

  it("asks for a progress report only once building has actually started", () => {
    const notStarted = evaluate({
      productCode: "hl_self_construct",
      customerProductCode: "home_loan",
      constructionStage: "not_started",
      properties: [{ casePropertyId: "cpr_1", role: "collateral" }],
    });
    expect(notStarted).not.toContain("construction_progress_report");

    const underway = evaluate({
      productCode: "hl_self_construct",
      customerProductCode: "home_loan",
      constructionStage: "walls",
      properties: [{ casePropertyId: "cpr_1", role: "collateral" }],
    });
    expect(underway).toContain("construction_progress_report");
  });
});

describe("the default pack — existing obligations", () => {
  it("asks for a loan statement only when there are obligations to declare", () => {
    const clean = evaluate({
      productCode: "pl",
      customerProductCode: "personal_loan",
      hasExistingObligations: false,
      parties: [individual({ employmentTypeCode: "salaried" })],
    });
    expect(clean).not.toContain("existing_loan_statement");

    const obliged = evaluate({
      productCode: "pl",
      customerProductCode: "personal_loan",
      hasExistingObligations: true,
      parties: [individual({ employmentTypeCode: "salaried" })],
    });
    expect(obliged).toContain("existing_loan_statement");
  });

  it("always asks a balance transfer for the statement and the foreclosure letter", () => {
    const asked = evaluate({
      productCode: "hl_balance_transfer",
      customerProductCode: "home_loan",
      parties: [individual({ employmentTypeCode: "salaried" })],
    });

    expect(asked).toContain("existing_loan_statement");
    expect(asked).toContain("foreclosure_letter");
  });
});

// ---------------------------------------------------------------------------
// Milestone 9.1 audit — regressions.
//
// Each of these failed before the audit. They are written as the sentence the
// office user said out loud when they found it.
// ---------------------------------------------------------------------------

describe("the audit — GST on a business loan, without anyone ticking a box", () => {
  /**
   * The reported P0-adjacent gap. `gstRequirement` is what the catalogue
   * declares (Database/migrations/0016): mandatory on the business products
   * and Commercial LAP, optional on home loans, not_applicable on gold.
   */
  it("asks a brand-new business loan for GST, with no facts recorded at all", () => {
    const asked = evaluate({
      productCode: "bl_unsecured",
      customerProductCode: "business_loan",
      gstRequirement: "mandatory",
      parties: [individual({ employmentTypeCode: "business_owner" })],
    });

    expect(asked).toContain("gst_certificate");
    expect(asked).toContain("gst_returns");
  });

  it("asks the firm rather than the proprietor once a firm is on the file", () => {
    const rows = evaluateRules(DEFAULT_REQUIREMENT_RULES, {
      productCode: "bl_working_capital",
      customerProductCode: "business_loan",
      gstRequirement: "mandatory",
      parties: [individual({ employmentTypeCode: "business_owner" }), firm()],
      properties: [],
    });

    const gst = rows.filter((row) => row.documentTypeCode === "gst_certificate");
    expect(gst).toHaveLength(1);
    expect(gst[0]?.casePartyId).toBe("cpt_firm");
  });

  it("does not ask a home loan for GST merely because the applicant is self-employed", () => {
    const asked = evaluate({
      productCode: "hl_purchase",
      customerProductCode: "home_loan",
      gstRequirement: "optional",
      parties: [individual({ employmentTypeCode: "self_employed" })],
    });

    expect(asked).not.toContain("gst_certificate");
    expect(asked).not.toContain("gst_returns");
  });

  it("still asks the moment somebody records that the borrower IS registered", () => {
    const asked = evaluate({
      productCode: "hl_purchase",
      customerProductCode: "home_loan",
      gstRequirement: "optional",
      isGstRegistered: true,
      parties: [individual({ employmentTypeCode: "self_employed" })],
    });

    expect(asked).toContain("gst_certificate");
    expect(asked).toContain("gst_returns");
  });
});

describe("the audit — a proprietor's business is underwritten like a firm's", () => {
  it("asks a business-loan proprietor with no firm on the file for CA-certified accounts", () => {
    const asked = evaluate({
      productCode: "bl_term_loan",
      customerProductCode: "business_loan",
      parties: [individual({ employmentTypeCode: "business_owner" })],
    });

    expect(asked).toContain("balance_sheet");
    expect(asked).toContain("profit_and_loss");
    expect(asked).toContain("org_itr");
    expect(asked).toContain("form_26as");
    // ...and NOT the personal ITR as well. On a proprietorship the business
    // return and the owner's return are one filing, and naming both put the
    // same document on the checklist twice.
    expect(asked).not.toContain("itr");
  });

  it("leaves the accounts to the firm's own rules once a firm is a party", () => {
    const rows = evaluateRules(DEFAULT_REQUIREMENT_RULES, {
      productCode: "bl_term_loan",
      customerProductCode: "business_loan",
      parties: [individual({ employmentTypeCode: "business_owner" }), firm()],
      properties: [],
    });

    const balanceSheets = rows.filter((row) => row.documentTypeCode === "balance_sheet");
    expect(balanceSheets).toHaveLength(1);
    expect(balanceSheets[0]?.casePartyId).toBe("cpt_firm");
  });

  it("does not ask an unsecured personal loan for a balance sheet", () => {
    const asked = evaluate({
      productCode: "pl_self_employed",
      customerProductCode: "personal_loan",
      parties: [individual({ employmentTypeCode: "self_employed" })],
    });

    expect(asked).toContain("itr");
    expect(asked).not.toContain("balance_sheet");
    expect(asked).not.toContain("profit_and_loss");
  });
});

describe("the audit — a gold loan asks for the ornaments and very little else", () => {
  it("does not pull a bureau report, chase obligations, or underwrite a guarantor", () => {
    const asked = evaluate({
      productCode: "gl_gold",
      customerProductCode: "gold_loan",
      hasExistingObligations: true,
      parties: [
        individual({ employmentTypeCode: "business_owner", hasExistingObligations: true }),
        individual({ casePartyId: "cpt_g", role: "guarantor" }),
      ],
    });

    expect(asked).toContain("gold_appraisal_note");
    expect(asked).toContain("pan_card");
    expect(asked).not.toContain("credit_bureau_consent");
    expect(asked).not.toContain("existing_loan_statement");
    expect(asked).not.toContain("net_worth_statement");
    expect(asked).not.toContain("balance_sheet");
    expect(asked).not.toContain("form_26as");
  });
});

describe("the audit — the whole validation matrix generates something sensible", () => {
  /**
   * The combinations named in the milestone brief. Asserted as shape rather
   * than as an exact list: an exact list would have to be rewritten every
   * time a business user edits a rule, which is precisely what the pack is
   * designed to let them do.
   */
  const property = (typeCode: string, role = "purchase"): CaseFacts["properties"] => [
    { casePropertyId: "cpr_1", role, propertyTypeCode: typeCode },
  ];

  const combinations: Array<{
    label: string;
    facts: Partial<CaseFacts> & Pick<CaseFacts, "productCode">;
    expects: string[];
    forbids: string[];
  }> = [
    {
      label: "Salaried Home Loan",
      facts: {
        productCode: "hl_purchase",
        customerProductCode: "home_loan",
        gstRequirement: "optional",
        parties: [individual({ employmentTypeCode: "salaried" })],
        properties: property("apartment"),
      },
      expects: ["pan_card", "salary_slip", "form_16", "sale_deed", "own_contribution_proof"],
      forbids: ["itr", "balance_sheet", "gst_returns", "patta_chitta", "construction_estimate"],
    },
    {
      label: "Self-employed Home Loan",
      facts: {
        productCode: "hl_purchase",
        customerProductCode: "home_loan",
        gstRequirement: "optional",
        parties: [individual({ employmentTypeCode: "self_employed" })],
        properties: property("independent_house"),
      },
      expects: ["itr", "form_26as", "balance_sheet", "profit_and_loss", "patta_chitta"],
      forbids: ["salary_slip", "form_16", "gst_returns"],
    },
    {
      label: "Business Loan",
      facts: {
        productCode: "bl_working_capital",
        customerProductCode: "business_loan",
        gstRequirement: "mandatory",
        securityTypeCode: "stock_book_debts",
        parties: [individual({ employmentTypeCode: "business_owner" })],
      },
      expects: [
        "gst_certificate",
        "gst_returns",
        "org_itr",
        "org_pan",
        "balance_sheet",
        "stock_statement",
      ],
      // The personal ITR is forbidden here, not missing by accident: the
      // business return covers it on a proprietorship.
      forbids: ["salary_slip", "sale_deed", "gold_appraisal_note", "itr"],
    },
    {
      label: "LAP",
      facts: {
        productCode: "lap",
        customerProductCode: "lap",
        gstRequirement: "optional",
        parties: [individual({ employmentTypeCode: "business_owner" })],
        properties: property("independent_house", "collateral"),
      },
      expects: ["sale_deed", "encumbrance_cert", "patta_chitta", "valuation_report", "itr"],
      forbids: ["sale_agreement", "own_contribution_proof", "construction_estimate"],
    },
    {
      label: "Plot Purchase",
      facts: {
        productCode: "hl_plot_purchase",
        customerProductCode: "home_loan",
        gstRequirement: "optional",
        parties: [individual({ employmentTypeCode: "salaried" })],
        properties: property("plot"),
      },
      expects: ["layout_approval", "patta_chitta", "sale_agreement", "own_contribution_proof"],
      forbids: ["construction_estimate", "approved_plan", "occupancy_certificate"],
    },
    {
      label: "Construction Loan",
      facts: {
        productCode: "hl_self_construct",
        customerProductCode: "home_loan",
        gstRequirement: "optional",
        constructionStage: "plinth",
        parties: [individual({ employmentTypeCode: "salaried" })],
        properties: property("plot", "collateral"),
      },
      expects: [
        "construction_estimate",
        "construction_progress_report",
        "approved_plan",
        "patta_chitta",
      ],
      forbids: ["sale_agreement", "layout_approval"],
    },
    {
      label: "Professional Loan",
      facts: {
        productCode: "pl_professional",
        customerProductCode: "personal_loan",
        gstRequirement: "optional",
        parties: [individual({ employmentTypeCode: "self_employed" })],
      },
      expects: ["qualification_proof", "professional_practice_proof", "itr", "form_26as"],
      forbids: ["balance_sheet", "sale_deed", "gst_returns", "salary_slip"],
    },
  ];

  for (const { label, facts, expects, forbids } of combinations) {
    it(`generates a sensible checklist for: ${label}`, () => {
      const asked = evaluate(facts);

      for (const code of expects) {
        expect(asked, `${label} should ask for ${code}`).toContain(code);
      }
      for (const code of forbids) {
        expect(asked, `${label} should NOT ask for ${code}`).not.toContain(code);
      }
      // Never a universal checklist: the case's own composition decides
      // (BR-033). Every generated row must name a document type only once
      // per subject, which `evaluateRules` guarantees by merging.
      expect(asked.length).toBeGreaterThan(5);
    });
  }

  it("raises practice proof to mandatory on the professional loan, not merely optional", () => {
    const rows = evaluateRules(DEFAULT_REQUIREMENT_RULES, {
      productCode: "pl_professional",
      customerProductCode: "personal_loan",
      parties: [individual({ employmentTypeCode: "self_employed" })],
      properties: [],
    });

    expect(
      rows.find((row) => row.documentTypeCode === "professional_practice_proof")?.applicability,
    ).toBe("mandatory");
  });

  it("asks an LLP for the resolution authorising it to borrow", () => {
    const asked = evaluate({
      productCode: "bl_term_loan",
      customerProductCode: "business_loan",
      parties: [
        individual({ employmentTypeCode: "business_owner" }),
        firm({ businessConstitutionCode: "llp" }),
      ],
    });

    expect(asked).toContain("llp_agreement");
    expect(asked).toContain("board_resolution");
  });
});

describe("the default pack — integrity", () => {
  it("has no duplicate rule codes", () => {
    const codes = DEFAULT_REQUIREMENT_RULES.map((rule) => rule.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("has no duplicate display orders, so the checklist order is stable", () => {
    const orders = DEFAULT_REQUIREMENT_RULES.map((rule) => rule.displayOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  // Read from the catalogue rather than from a second list written out here.
  // A hand-kept copy drifts, and the drift is silent: a rule asking for years
  // of a type the expander does not know recurs loses its period and collapses
  // to one undated row.
  it("only asks for financial years on document types that recur", () => {
    for (const rule of DEFAULT_REQUIREMENT_RULES) {
      if (rule.financialYears !== undefined) {
        expect(isFinancialYearScoped(rule.documentTypeCode)).toBe(true);
      }
    }
  });

  it("scopes every party rule to a role that can actually supply the document", () => {
    for (const rule of DEFAULT_REQUIREMENT_RULES) {
      if (rule.scope !== "party") continue;
      expect(rule.partyRoles?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("names a manageable, non-empty set of document types", () => {
    const codes = defaultRuleDocumentTypeCodes();
    expect(codes.length).toBeGreaterThan(40);
    expect(new Set(codes).size).toBe(codes.length);
  });

  // The failure this guards against is the worst one a checklist has: a rule
  // naming a type nobody created generates NOTHING, and the case looks as
  // though it simply does not need the document.
  it("never names a document type that does not exist", () => {
    const known = new Set(allDocumentTypeCodes());
    const unknown = defaultRuleDocumentTypeCodes().filter((code) => !known.has(code));

    expect(unknown).toEqual([]);
  });
});

/**
 * The Telecaller Workflow milestone. Every test here is a complaint from
 * someone using AOS on the phone, turned into an assertion.
 */
describe("the checklist a telecaller actually reads out", () => {
  it("asks a brand-new business loan for the business documents, without waiting for anyone to record what kind of business it is", () => {
    // The exact shape of a case created during the first call: one applicant,
    // no firm, no employment type, nothing else answered yet. This was the
    // gap — the newest business loan in the system had the emptiest list.
    const asked = evaluate({
      productCode: "bl_working_capital",
      customerProductCode: "business_loan",
      gstRequirement: "mandatory",
    });

    expect(asked).toContain("business_proof");
    expect(asked).toContain("org_pan");
    expect(asked).toContain("org_address_proof");
    expect(asked).toContain("org_bank_statement");
    expect(asked).toContain("org_itr");
    expect(asked).toContain("balance_sheet");
    expect(asked).toContain("profit_and_loss");
    expect(asked).toContain("gst_certificate");
    expect(asked).toContain("gst_returns");
    expect(asked).toContain("udyam_certificate");
    // And the KYC that goes with it.
    expect(asked).toContain("pan_card");
    expect(asked).toContain("aadhaar_card");
    expect(asked).toContain("address_proof");
    expect(asked).toContain("photograph");
  });

  it("stands the by-product business rules down once a real firm is on the file, so nothing is asked for twice", () => {
    const rows = evaluateRules(DEFAULT_REQUIREMENT_RULES, {
      productCode: "bl_working_capital",
      customerProductCode: "business_loan",
      parties: [individual(), firm({ businessConstitutionCode: "partnership" })],
      properties: [],
    });

    // The applicant is asked for KYC, not for the firm's books.
    const applicantDocs = rows
      .filter((row) => row.casePartyId === "cpt_applicant")
      .map((row) => row.documentTypeCode);
    expect(applicantDocs).not.toContain("business_proof");
    expect(applicantDocs).not.toContain("org_bank_statement");

    // The firm is.
    const firmDocs = rows
      .filter((row) => row.casePartyId === "cpt_firm")
      .map((row) => row.documentTypeCode);
    expect(firmDocs).toContain("business_proof");
    expect(firmDocs).toContain("org_bank_statement");
    expect(firmDocs).toContain("partnership_deed");
  });

  it("asks for three financial years of GST returns, because a two-point comparison is barely a trend", () => {
    const rows = evaluateRules(DEFAULT_REQUIREMENT_RULES, {
      productCode: "bl_working_capital",
      customerProductCode: "business_loan",
      gstRequirement: "mandatory",
      parties: [individual(), firm()],
      properties: [],
    });

    const gstReturns = rows.find(
      (row) => row.documentTypeCode === "gst_returns" && row.casePartyId === "cpt_firm",
    );
    expect(gstReturns?.financialYears).toBe(3);
  });

  /**
   * The scenario this test guards: a real ₹65L Machinery & Equipment Loan for
   * a GST-registered proprietor, reported by a telecaller as producing an
   * "obviously incomplete" checklist. It was not — every document below
   * already fired — but GST returns and business ITR fired at two trailing
   * years instead of three, which is the actual defect this milestone fixes.
   */
  it("asks a GST-registered proprietor on a ₹65L Machinery & Equipment Loan for the full business set", () => {
    const rows = evaluateRules(DEFAULT_REQUIREMENT_RULES, {
      productCode: "bl_machinery",
      customerProductCode: "business_loan",
      gstRequirement: "mandatory",
      requestedAmount: 6_500_000,
      parties: [individual({ employmentTypeCode: "business_owner", isGstRegistered: true })],
      properties: [],
    });
    const asked = rows.map((row) => row.documentTypeCode);

    // KYC — universal.
    expect(asked).toContain("pan_card");
    expect(asked).toContain("aadhaar_card");
    expect(asked).toContain("address_proof");
    expect(asked).toContain("photograph");

    // Business registration — mandatory on the MSME schemes, machinery among them.
    expect(asked).toContain("udyam_certificate");

    // GST — driven by the product's own gst_requirement, not by anyone having
    // to answer a question first.
    expect(asked).toContain("gst_certificate");
    const gstReturns = rows.find((row) => row.documentTypeCode === "gst_returns");
    expect(gstReturns?.financialYears).toBe(3);

    // Business ITR — three assessment years, the fix this test exists for.
    const businessItr = rows.find((row) => row.documentTypeCode === "org_itr");
    expect(businessItr?.financialYears).toBe(3);

    // The asset being financed.
    expect(asked).toContain("machinery_quotation");
  });

  it("asks for the Tamil Nadu property core the moment a property exists, and not a moment before", () => {
    const withoutProperty = evaluate({
      productCode: "hl_purchase",
      customerProductCode: "home_loan",
    });
    expect(withoutProperty).not.toContain("patta_chitta");
    expect(withoutProperty).not.toContain("encumbrance_cert");
    expect(withoutProperty).not.toContain("parent_document");

    const withProperty = evaluate({
      productCode: "hl_purchase",
      customerProductCode: "home_loan",
      properties: [
        { casePropertyId: "cpr_1", role: "purchase", propertyTypeCode: "independent_house" },
      ],
    });
    expect(withProperty).toContain("patta_chitta");
    expect(withProperty).toContain("encumbrance_cert");
    expect(withProperty).toContain("parent_document");
    expect(withProperty).toContain("sale_deed");
    expect(withProperty).toContain("property_tax_receipt");
    expect(withProperty).toContain("approved_plan");
  });

  /**
   * The rule NAME is what appears under "Asked for by" on the case screen. A
   * name only a credit manager understands is a name the telecaller has to
   * translate live, differently every time.
   */
  it("names no rule after the internal banking vocabulary the milestone set out to remove", () => {
    const banned = [/credit bureau/i, /title chain/i, /book debts/i, /lease rental discounting/i];
    const offenders = DEFAULT_REQUIREMENT_RULES.filter((rule) =>
      banned.some((pattern) => pattern.test(rule.name)),
    ).map((rule) => rule.code);

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Customer documents only (case intake milestone, Part 10)
// ---------------------------------------------------------------------------

describe("the default pack asks a customer only for customer documents", () => {
  /**
   * THE INVARIANT. A requirement rule puts a row on a telecaller's collection
   * list. A row for the lender's own login form, its NACH mandate or Amaze's
   * internal application form can never be satisfied by a collection call —
   * and live use answered them the only way it could, by waiving them, which
   * spends a decision that is supposed to mean "this file goes to the bank
   * with a known gap, and my name is on it" (BR-035).
   */
  it("has no active rule asking for a bank or internal artifact", () => {
    expect(activeRulesAskingForNonCustomerDocuments().map((rule) => rule.code)).toEqual([]);
  });

  it("keeps the three retired rules readable rather than deleting them", () => {
    // Deleting a rule takes its history with it, and leaves the next person to
    // wonder whether asking for a login form was ever considered.
    for (const code of ["case_login_form", "case_nach_mandate", "case_application_form"]) {
      const rule = DEFAULT_REQUIREMENT_RULES.find((r) => r.code === code);
      expect(rule, code).toBeDefined();
      expect(rule!.isActive, code).toBe(false);
      expect(rule!.notes, code).toMatch(/RETIRED/);
    }
  });

  it("generates none of them for an ordinary case", () => {
    const asked = evaluate({ productCode: "lap", customerProductCode: "lap" });
    expect(asked).not.toContain("login_form");
    expect(asked).not.toContain("nach_mandate");
    expect(asked).not.toContain("application_form");
  });
});

// ---------------------------------------------------------------------------
// ITR, and the difference between "no" and "not asked" (Part 8)
// ---------------------------------------------------------------------------

describe("the default pack — ITR against a customer who does not file", () => {
  const selfEmployed = (itrFiled?: boolean): string[] =>
    evaluate({
      productCode: "lap",
      customerProductCode: "lap",
      parties: [
        individual({
          employmentTypeCode: "business_owner",
          ...(itrFiled === undefined ? {} : { itrFiled }),
        }),
      ],
    });

  it("asks a self-employed customer for the return when nobody has been asked yet", () => {
    // The failure this guards against is a rule built on `is_true`, which
    // would fire on nothing until somebody ticked a box — so the newest case
    // in the system would have the emptiest checklist, which is the exact bug
    // the 0026 audit found on the GST rules.
    expect(selfEmployed(undefined)).toContain("itr");
  });

  it("asks when the customer says they do file", () => {
    expect(selfEmployed(true)).toContain("itr");
  });

  it("stops asking only when the customer says they do not", () => {
    expect(selfEmployed(false)).not.toContain("itr");
  });

  it("still asks for banking and business proof when there is no return", () => {
    // Not filing is not a reason to stop assessing income — it changes WHICH
    // evidence exists, not whether any is needed.
    const asked = selfEmployed(false);
    expect(asked).toContain("bank_statement");
    expect(asked).toContain("business_proof");
  });
});
