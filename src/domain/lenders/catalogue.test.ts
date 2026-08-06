import { describe, expect, it } from "vitest";

import {
  branchesOf,
  describeBranchCount,
  describeInstitution,
  describeTurnaround,
  filterLenders,
  insightsFor,
  isLodgeable,
  lenderAvailability,
  matchesFilter,
  submissionRulesFor,
  supportedProductCodes,
  type LenderBranch,
  type LenderInsight,
  type LenderInstitution,
  type SubmissionRule,
  type SupportedProduct,
} from "./catalogue.js";

function institution(overrides: Partial<LenderInstitution> = {}): LenderInstitution {
  return {
    code: "kvb",
    name: "Karur Vysya Bank",
    lenderTypeCode: "private_sector_bank",
    headOfficeCity: "Karur",
    primaryServiceRegion: "Tamil Nadu",
    isOnPanel: true,
    isActive: true,
    ...overrides,
  };
}

function branch(overrides: Partial<LenderBranch> = {}): LenderBranch {
  return {
    id: "brn_1",
    institutionCode: "kvb",
    name: "Karur Vysya Bank — Coimbatore",
    cityCode: "coimbatore",
    districtCode: "coimbatore",
    status: "operational",
    isActive: true,
    ...overrides,
  };
}

function supported(overrides: Partial<SupportedProduct> = {}): SupportedProduct {
  return {
    id: "bp_1",
    organisationCode: "kvb",
    lendingProductCode: "lap",
    isActive: true,
    ...overrides,
  };
}

function insight(overrides: Partial<LenderInsight> = {}): LenderInsight {
  return {
    id: "ins_1",
    organisationCode: "kvb",
    categoryCode: "strength",
    body: "Quick on MSME manufacturing cases.",
    isActive: true,
    ...overrides,
  };
}

function rule(overrides: Partial<SubmissionRule> = {}): SubmissionRule {
  return {
    id: "rul_1",
    organisationCode: "kvb",
    isActive: true,
    ...overrides,
  };
}

describe("availability", () => {
  it("treats an active, on-panel lender as available", () => {
    expect(lenderAvailability(institution())).toBe("available");
  });

  // Off-panel is a decision Amaze made and can reverse this afternoon;
  // inactive usually means the lender has merged or ceased. Reporting them
  // as one state would lose that.
  it("separates a lender taken off panel from one that no longer exists", () => {
    expect(lenderAvailability(institution({ isOnPanel: false }))).toBe("off_panel");
    expect(lenderAvailability(institution({ isActive: false }))).toBe("inactive");
  });

  it("reports a lender that is both inactive and off panel as inactive", () => {
    expect(lenderAvailability(institution({ isActive: false, isOnPanel: false }))).toBe("inactive");
  });
});

describe("branches", () => {
  it("will not lodge at a temporarily closed branch", () => {
    expect(isLodgeable(branch())).toBe(true);
    expect(isLodgeable(branch({ status: "temporarily_closed" }))).toBe(false);
    expect(isLodgeable(branch({ status: "closed" }))).toBe(false);
    expect(isLodgeable(branch({ isActive: false }))).toBe(false);
  });

  it("lists the branches you can actually lodge at first", () => {
    const branches = [
      branch({ id: "b1", name: "Zeta", status: "closed" }),
      branch({ id: "b2", name: "Beta" }),
      branch({ id: "b3", name: "Alpha" }),
      branch({ id: "b4", institutionCode: "tmb", name: "Other bank" }),
    ];
    expect(branchesOf(institution(), branches).map((b) => b.name)).toEqual([
      "Alpha",
      "Beta",
      "Zeta",
    ]);
  });
});

describe("supported products", () => {
  // Both placements are meaningful: most lenders record a product once at
  // the institution, and a branch row is the exception where one branch
  // differs. "Does this lender do LAP?" is yes for either.
  it("counts products recorded against the institution and against its branches", () => {
    const context = {
      branches: [branch({ id: "brn_1" })],
      supportedProducts: [
        supported({ id: "p1", organisationCode: "kvb", lendingProductCode: "lap" }),
        supported({ id: "p2", organisationCode: "brn_1", lendingProductCode: "bl_term_loan" }),
      ],
    };
    expect([...supportedProductCodes(institution(), context)].sort()).toEqual([
      "bl_term_loan",
      "lap",
    ]);
  });

  it("ignores products recorded against another lender, and inactive ones", () => {
    const context = {
      supportedProducts: [
        supported({ id: "p1", organisationCode: "tmb", lendingProductCode: "gl_gold" }),
        supported({ id: "p2", lendingProductCode: "hl_purchase", isActive: false }),
      ],
    };
    expect([...supportedProductCodes(institution(), context)]).toEqual([]);
  });
});

describe("filtering", () => {
  const lenders = [
    institution(),
    institution({ code: "sbi", name: "State Bank of India", lenderTypeCode: "public_sector_bank", headOfficeCity: "Mumbai", primaryServiceRegion: "Pan-India" }),
    institution({ code: "chola", name: "Cholamandalam Investment and Finance Company", lenderTypeCode: "nbfc", headOfficeCity: "Chennai", aliases: ["Chola"] }),
    institution({ code: "lvb", name: "Lakshmi Vilas Bank", isActive: false }),
    institution({ code: "aavas", name: "Aavas Financiers", lenderTypeCode: "housing_finance_company", isOnPanel: false }),
  ];

  it("hides lenders that no longer exist unless asked", () => {
    expect(filterLenders(lenders, {}).map((l) => l.code)).not.toContain("lvb");
    expect(filterLenders(lenders, { includeInactive: true }).map((l) => l.code)).toContain("lvb");
  });

  it("matches words in any order, across name, alias and region", () => {
    expect(filterLenders(lenders, { query: "chola" }).map((l) => l.code)).toEqual(["chola"]);
    expect(filterLenders(lenders, { query: "india bank state" }).map((l) => l.code)).toEqual(["sbi"]);
  });

  // The mistake that makes a filter panel feel broken: an empty box that
  // matches nothing instead of everything.
  it("treats an empty query as no narrowing at all", () => {
    expect(filterLenders(lenders, { query: "   " })).toHaveLength(4);
  });

  it("narrows by lender type and by panel status", () => {
    expect(filterLenders(lenders, { lenderTypeCode: "nbfc" }).map((l) => l.code)).toEqual(["chola"]);
    expect(filterLenders(lenders, { onPanelOnly: true }).map((l) => l.code)).not.toContain("aavas");
  });

  it("narrows to lenders with a branch in a district", () => {
    const context = {
      branches: [
        branch({ id: "b1", institutionCode: "kvb", districtCode: "coimbatore" }),
        branch({ id: "b2", institutionCode: "sbi", districtCode: "erode", cityCode: "erode" }),
      ],
    };
    expect(filterLenders(lenders, { districtCode: "coimbatore" }, context).map((l) => l.code)).toEqual([
      "kvb",
    ]);
    expect(filterLenders(lenders, { cityCode: "erode" }, context).map((l) => l.code)).toEqual(["sbi"]);
  });

  it("does not count a branch of a deactivated organisation towards a district", () => {
    const context = {
      branches: [branch({ id: "b1", districtCode: "coimbatore", isActive: false })],
    };
    expect(filterLenders(lenders, { districtCode: "coimbatore" }, context)).toEqual([]);
  });

  it("narrows to lenders that support a lending product", () => {
    const context = { supportedProducts: [supported({ lendingProductCode: "lap" })] };
    expect(filterLenders(lenders, { lendingProductCode: "lap" }, context).map((l) => l.code)).toEqual([
      "kvb",
    ]);
    expect(filterLenders(lenders, { lendingProductCode: "gl_gold" }, context)).toEqual([]);
  });

  it("combines every filter", () => {
    const context = {
      branches: [branch({ id: "b1", districtCode: "coimbatore" })],
      supportedProducts: [supported({ lendingProductCode: "lap" })],
    };
    expect(
      matchesFilter(
        institution(),
        {
          query: "karur",
          lenderTypeCode: "private_sector_bank",
          districtCode: "coimbatore",
          lendingProductCode: "lap",
          onPanelOnly: true,
        },
        context,
      ),
    ).toBe(true);
  });
});

describe("the lender profile", () => {
  it("groups insights by category, in the order the office reads them", () => {
    const insights = [
      insight({ id: "i1", categoryCode: "limitation" }),
      insight({ id: "i2", categoryCode: "strength" }),
      insight({ id: "i3", categoryCode: "strength" }),
    ];
    const groups = insightsFor(["kvb"], insights, ["segment_fit", "strength", "limitation"]);
    expect(groups.map((g) => g.categoryCode)).toEqual(["strength", "limitation"]);
    expect(groups[0]?.insights).toHaveLength(2);
  });

  // A category somebody added this morning should not displace the ones the
  // team reads every day.
  it("sorts an unknown category last rather than first", () => {
    const groups = insightsFor(
      ["kvb"],
      [insight({ id: "i1", categoryCode: "brand_new" }), insight({ id: "i2", categoryCode: "strength" })],
      ["strength"],
    );
    expect(groups.map((g) => g.categoryCode)).toEqual(["strength", "brand_new"]);
  });

  it("shows the most recent observation first, because experience ages", () => {
    const groups = insightsFor(
      ["kvb"],
      [
        insight({ id: "old", observedOn: "2024-01-01", body: "Stale." }),
        insight({ id: "new", observedOn: "2026-06-01", body: "Current." }),
      ],
      ["strength"],
    );
    expect(groups[0]?.insights.map((i) => i.id)).toEqual(["new", "old"]);
  });

  it("includes a branch's own insights alongside its institution's", () => {
    const insights = [
      insight({ id: "i1", organisationCode: "kvb" }),
      insight({ id: "i2", organisationCode: "brn_1" }),
      insight({ id: "i3", organisationCode: "sbi" }),
    ];
    const groups = insightsFor(["kvb", "brn_1"], insights, ["strength"]);
    expect(groups[0]?.insights.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
  });

  it("drops deactivated insights", () => {
    expect(insightsFor(["kvb"], [insight({ isActive: false })])).toEqual([]);
  });
});

describe("submission rules", () => {
  it("reads the most specific rule first, without hiding the general one", () => {
    const rules = [
      rule({ id: "general", organisationCode: "kvb" }),
      rule({ id: "product", organisationCode: "kvb", lendingProductCode: "lap" }),
      rule({ id: "branch", organisationCode: "brn_1" }),
    ];
    expect(submissionRulesFor(["kvb", "brn_1"], rules, "lap").map((r) => r.id)).toEqual([
      "product",
      "branch",
      "general",
    ]);
  });

  it("leaves out a rule written for a different product", () => {
    const rules = [
      rule({ id: "lap", lendingProductCode: "lap" }),
      rule({ id: "home", lendingProductCode: "hl_purchase" }),
    ];
    expect(submissionRulesFor(["kvb"], rules, "lap").map((r) => r.id)).toEqual(["lap"]);
  });

  it("shows every rule when no product has been chosen", () => {
    const rules = [
      rule({ id: "lap", lendingProductCode: "lap" }),
      rule({ id: "home", lendingProductCode: "hl_purchase" }),
    ];
    expect(submissionRulesFor(["kvb"], rules)).toHaveLength(2);
  });
});

describe("presentation", () => {
  it("describes a turnaround in office language, or not at all", () => {
    expect(describeTurnaround(7)).toBe("About 7 days");
    expect(describeTurnaround(1)).toBe("About 1 day");
    expect(describeTurnaround(undefined)).toBeUndefined();
    expect(describeTurnaround(0)).toBeUndefined();
  });

  it("counts branches without saying '1 branches'", () => {
    expect(describeBranchCount(0)).toBe("No branches recorded");
    expect(describeBranchCount(1)).toBe("1 branch");
    expect(describeBranchCount(3)).toBe("3 branches");
  });

  it("summarises an institution and skips what nobody has filled in", () => {
    expect(describeInstitution(institution({ typicalTurnaroundDays: 10 }), "Private Sector Bank")).toBe(
      "Private Sector Bank · Tamil Nadu · About 10 days",
    );
    expect(
      describeInstitution({
        code: "x",
        name: "X",
        isOnPanel: true,
        isActive: true,
      }),
    ).toBe("");
  });
});
