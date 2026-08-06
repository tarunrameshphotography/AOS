/**
 * The default rule pack, tested as business behaviour rather than as data.
 *
 * Each test below is a sentence an office user would recognise. If one of
 * them fails, a real checklist is wrong — which is a different and more
 * serious thing than a unit test failing.
 */

import { describe, expect, it } from "vitest";

import { allDocumentTypeCodes, ENGINE_DOCUMENT_TYPES } from "./document-catalogue.js";
import { DEFAULT_REQUIREMENT_RULES, defaultRuleDocumentTypeCodes } from "./default-rules.js";
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

  it("asks two financial years of ITR and one of banking", () => {
    const rows = evaluateRules(DEFAULT_REQUIREMENT_RULES, {
      productCode: "bl_unsecured",
      customerProductCode: "business_loan",
      parties: [individual({ employmentTypeCode: "business_owner" })],
      properties: [],
    });

    expect(rows.find((row) => row.documentTypeCode === "itr")?.financialYears).toBe(2);
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

describe("the default pack — integrity", () => {
  it("has no duplicate rule codes", () => {
    const codes = DEFAULT_REQUIREMENT_RULES.map((rule) => rule.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("has no duplicate display orders, so the checklist order is stable", () => {
    const orders = DEFAULT_REQUIREMENT_RULES.map((rule) => rule.displayOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("only asks for financial years on document types that recur", () => {
    const recurring = new Set([
      "itr",
      "org_itr",
      "gst_returns",
      "balance_sheet",
      "profit_and_loss",
      "bank_statement",
      "org_bank_statement",
      "form_16",
      "audit_report",
    ]);

    for (const rule of DEFAULT_REQUIREMENT_RULES) {
      if (rule.financialYears !== undefined) {
        expect(recurring.has(rule.documentTypeCode)).toBe(true);
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

  it("has no duplicate document type codes or display orders in the engine catalogue", () => {
    const codes = ENGINE_DOCUMENT_TYPES.map((type) => type.code);
    const orders = ENGINE_DOCUMENT_TYPES.map((type) => type.displayOrder);

    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(orders).size).toBe(orders.length);
  });
});
