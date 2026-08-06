import { describe, expect, it } from "vitest";

import {
  evaluateCondition,
  evaluateRules,
  explainRequirement,
  resolveFact,
  type CaseFacts,
  type PartyFacts,
  type RequirementRule,
} from "./rules.js";

function party(overrides: Partial<PartyFacts> = {}): PartyFacts {
  return {
    casePartyId: "cpt_1",
    role: "applicant",
    kind: "person",
    ...overrides,
  };
}

function facts(overrides: Partial<CaseFacts> = {}): CaseFacts {
  return {
    productCode: "hl_purchase",
    customerProductCode: "home_loan",
    parties: [party()],
    properties: [],
    ...overrides,
  };
}

function rule(overrides: Partial<RequirementRule> = {}): RequirementRule {
  return {
    code: "test_rule",
    name: "Test rule",
    documentTypeCode: "pan_card",
    scope: "party",
    applicability: "mandatory",
    applicableFromStage: "documents_pending",
    conditions: [],
    isActive: true,
    displayOrder: 10,
    ...overrides,
  };
}

describe("resolveFact", () => {
  it("derives case-level presence facts from the composition rather than storing them", () => {
    const withGuarantor = facts({
      parties: [party(), party({ casePartyId: "cpt_2", role: "guarantor" })],
    });

    expect(resolveFact("case.has_guarantor", withGuarantor)).toBe(true);
    expect(resolveFact("case.has_co_applicant", withGuarantor)).toBe(false);
    expect(resolveFact("case.has_collateral", withGuarantor)).toBe(false);
  });

  it("falls back from a party's GST answer to the case's", () => {
    const caseFacts = facts({ isGstRegistered: true });

    expect(resolveFact("party.is_gst_registered", caseFacts, { party: party() })).toBe(true);
    expect(
      resolveFact("party.is_gst_registered", caseFacts, {
        party: party({ isGstRegistered: false }),
      }),
    ).toBe(false);
  });

  it("returns undefined for a party fact asked outside a party scope, rather than throwing", () => {
    expect(resolveFact("party.employment_type", facts())).toBeUndefined();
  });
});

describe("evaluateCondition", () => {
  it("distinguishes 'explicitly false' from 'not yet answered'", () => {
    const unanswered = facts();
    const answeredNo = facts({ isGstRegistered: false });

    const condition = { fact: "case.is_gst_registered", operator: "is_false" } as const;

    expect(evaluateCondition(condition, unanswered)).toBe(false);
    expect(evaluateCondition(condition, answeredNo)).toBe(true);
  });

  it("treats an unknown fact as satisfying not_in", () => {
    // "Ask for income proof unless this is a gold loan" must still ask when
    // the customer product has not been recorded.
    const condition = {
      fact: "case.customer_product_code",
      operator: "not_in",
      values: ["gold_loan"],
    } as const;

    expect(evaluateCondition(condition, facts({ customerProductCode: undefined }))).toBe(true);
    expect(evaluateCondition(condition, facts({ customerProductCode: "gold_loan" }))).toBe(false);
  });

  it("compares booleans by value, not by truthiness", () => {
    const condition = { fact: "case.has_collateral", operator: "is_true" } as const;

    expect(evaluateCondition(condition, facts())).toBe(false);
    expect(
      evaluateCondition(
        condition,
        facts({ properties: [{ casePropertyId: "cpr_1", role: "collateral" }] }),
      ),
    ).toBe(true);
  });
});

describe("evaluateRules", () => {
  it("generates one row per matching party — absence is silence (ADR-010)", () => {
    const generated = evaluateRules([rule()], facts());
    expect(generated).toHaveLength(1);
    expect(generated[0]?.casePartyId).toBe("cpt_1");

    // No co-applicant on the file: the co-applicant rule produces NO ROWS,
    // not rows marked not_applicable.
    const coApplicantOnly = evaluateRules(
      [rule({ code: "co_only", partyRoles: ["co_applicant"] })],
      facts(),
    );
    expect(coApplicantOnly).toHaveLength(0);
  });

  it("never generates anything for a referrer, whatever the rule says", () => {
    const generated = evaluateRules(
      [rule({ partyRoles: ["applicant", "referrer"] })],
      facts({ parties: [party({ casePartyId: "cpt_9", role: "referrer" })] }),
    );

    expect(generated).toHaveLength(0);
  });

  it("respects partyKind, so a firm never collects an individual's KYC", () => {
    const generated = evaluateRules(
      [rule({ partyKind: "person", partyRoles: ["applicant", "borrower_firm"] })],
      facts({
        parties: [party({ casePartyId: "cpt_f", role: "borrower_firm", kind: "organisation" })],
      }),
    );

    expect(generated).toHaveLength(0);
  });

  it("emits nothing for an inactive rule or one marked not_applicable", () => {
    expect(evaluateRules([rule({ isActive: false })], facts())).toHaveLength(0);
    expect(evaluateRules([rule({ applicability: "not_applicable" })], facts())).toHaveLength(0);
  });

  it("evaluates a property rule once per property, and not at all without one", () => {
    const propertyRule = rule({ scope: "property", documentTypeCode: "sale_deed" });

    expect(evaluateRules([propertyRule], facts())).toHaveLength(0);
    expect(
      evaluateRules(
        [propertyRule],
        facts({
          properties: [
            { casePropertyId: "cpr_1", role: "collateral" },
            { casePropertyId: "cpr_2", role: "purchase" },
          ],
        }),
      ),
    ).toHaveLength(2);
  });

  it("merges two rules landing on the same document, taking the stricter reading", () => {
    const optionalEarly = rule({
      code: "optional_rule",
      documentTypeCode: "bank_statement",
      applicability: "optional",
      applicableFromStage: "ready_for_submission",
      financialYears: 1,
      displayOrder: 10,
    });
    const mandatoryLater = rule({
      code: "mandatory_rule",
      documentTypeCode: "bank_statement",
      applicability: "mandatory",
      applicableFromStage: "documents_pending",
      financialYears: 2,
      displayOrder: 20,
    });

    const generated = evaluateRules([optionalEarly, mandatoryLater], facts());

    expect(generated).toHaveLength(1);
    expect(generated[0]?.applicability).toBe("mandatory");
    expect(generated[0]?.applicableFromStage).toBe("documents_pending");
    expect(generated[0]?.financialYears).toBe(2);
  });

  it("applies 'any' matching when asked, and 'all' by default", () => {
    const conditions = [
      { fact: "case.product_code", operator: "equals", values: ["hl_purchase"] },
      { fact: "case.product_code", operator: "equals", values: ["lap"] },
    ] as const;

    expect(evaluateRules([rule({ conditions, match: "any" })], facts())).toHaveLength(1);
    expect(evaluateRules([rule({ conditions })], facts())).toHaveLength(0);
  });

  it("is deterministic — the same facts and rules give the same answer", () => {
    const rules = [
      rule({ code: "a", documentTypeCode: "pan_card", displayOrder: 20 }),
      rule({ code: "b", documentTypeCode: "aadhaar_card", displayOrder: 10 }),
    ];

    const first = evaluateRules(rules, facts());
    const second = evaluateRules(rules, facts());

    expect(first).toEqual(second);
    // Ordered by displayOrder, not by declaration.
    expect(first.map((row) => row.documentTypeCode)).toEqual(["aadhaar_card", "pan_card"]);
  });
});

describe("explainRequirement", () => {
  it("names the rule that asked for a document — the 'why?' a checklist owes its user", () => {
    const rules = [rule({ code: "kyc_pan", name: "PAN card — every individual signing" })];

    const explanation = explainRequirement(rules, facts(), {
      documentTypeCode: "pan_card",
      casePartyId: "cpt_1",
    });

    expect(explanation.map((r) => r.code)).toEqual(["kyc_pan"]);
  });
});
