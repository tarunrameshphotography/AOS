import { describe, expect, it } from "vitest";

import {
  describeAmount,
  describeAmountRange,
  describeTenure,
  filterProducts,
  isOfferable,
  isRequired,
  matchesFilter,
  productAvailability,
  supersededCodes,
  type LendingProduct,
} from "./catalogue.js";

function product(overrides: Partial<LendingProduct> = {}): LendingProduct {
  return {
    code: "lap",
    name: "Loan Against Property — Residential",
    categoryCode: "lap",
    securityTypeCode: "immovable_property",
    borrowerTypeCodes: ["resident_individual", "non_individual"],
    employmentTypeCodes: ["salaried", "self_employed", "business_owner"],
    businessConstitutionCodes: ["proprietorship", "partnership"],
    propertyRequirement: "mandatory",
    gstRequirement: "optional",
    minTenureMonths: 36,
    maxTenureMonths: 240,
    minAmount: 500000,
    maxAmount: 100000000,
    isActive: true,
    ...overrides,
  };
}

const TODAY = "2026-08-06";

describe("availability", () => {
  it("offers an active product with no dates", () => {
    expect(productAvailability(product(), TODAY)).toBe("offerable");
  });

  it("does not offer a product whose effective_from is in the future", () => {
    expect(productAvailability(product({ effectiveFrom: "2026-09-01" }), TODAY)).toBe(
      "not_yet_effective",
    );
  });

  it("offers a product on the first day it is effective", () => {
    expect(productAvailability(product({ effectiveFrom: TODAY }), TODAY)).toBe("offerable");
  });

  it("offers a product on the last day it is effective, and not the next", () => {
    const retiring = product({ effectiveTo: TODAY });
    expect(productAvailability(retiring, TODAY)).toBe("offerable");
    expect(productAvailability(retiring, "2026-08-07")).toBe("expired");
  });

  it("reports a deactivated product as retired", () => {
    expect(productAvailability(product({ isActive: false }), TODAY)).toBe("retired");
  });

  it("reports a superseded product as superseded, not merely retired", () => {
    // The distinction is the whole point: only one of the two can tell the
    // user where the product went.
    const superseded = new Set(["lap"]);
    expect(productAvailability(product({ isActive: false }), TODAY, superseded)).toBe("superseded");
  });

  it("derives which codes have been superseded from the revisions that name them", () => {
    const codes = supersededCodes([
      product({ code: "lap_v2", supersedesProductCode: "lap" }),
      product({ code: "pl" }),
    ]);
    expect([...codes]).toEqual(["lap"]);
  });

  it("tolerates a full ISO timestamp where a date is expected", () => {
    expect(isOfferable(product({ effectiveTo: "2026-08-06T00:00:00.000Z" }), TODAY)).toBe(true);
  });
});

describe("filtering", () => {
  const catalogue: LendingProduct[] = [
    product(),
    product({
      code: "pl",
      name: "Personal Loan — Salaried",
      categoryCode: "personal_loan",
      securityTypeCode: "unsecured",
      borrowerTypeCodes: ["resident_individual"],
      employmentTypeCodes: ["salaried"],
      businessConstitutionCodes: [],
      propertyRequirement: "not_applicable",
      gstRequirement: "not_applicable",
    }),
    product({
      code: "bl_unsecured",
      name: "Unsecured Business Loan",
      description: "Clean business lending priced against banking turnover and GST returns.",
      categoryCode: "business_loan",
      securityTypeCode: "unsecured",
      employmentTypeCodes: ["self_employed", "business_owner"],
      businessConstitutionCodes: ["proprietorship", "private_limited"],
      propertyRequirement: "not_applicable",
      gstRequirement: "mandatory",
    }),
    product({ code: "hl_retired", name: "Retired Home Loan", isActive: false }),
  ];

  const codes = (filter: Parameters<typeof filterProducts>[1]): string[] =>
    filterProducts(catalogue, { on: TODAY, ...filter }).map((p) => p.code);

  it("hides retired products unless asked for them", () => {
    expect(codes({})).toEqual(["lap", "pl", "bl_unsecured"]);
    expect(codes({ includeInactive: true })).toContain("hl_retired");
  });

  it("matches every search word independently of order", () => {
    expect(codes({ query: "business unsecured" })).toEqual(["bl_unsecured"]);
    expect(codes({ query: "unsecured business" })).toEqual(["bl_unsecured"]);
  });

  it("searches the description, not only the name", () => {
    expect(codes({ query: "turnover" })).toEqual(["bl_unsecured"]);
  });

  it("narrows by category and by security", () => {
    expect(codes({ categoryCode: "lap" })).toEqual(["lap"]);
    expect(codes({ securityTypeCode: "unsecured" })).toEqual(["pl", "bl_unsecured"]);
  });

  it("narrows by employment eligibility", () => {
    expect(codes({ employmentTypeCode: "salaried" })).toEqual(["lap", "pl"]);
    expect(codes({ employmentTypeCode: "business_owner" })).toEqual(["lap", "bl_unsecured"]);
  });

  it("treats an empty eligibility list as admitting nobody", () => {
    // The salaried personal loan has no business constitutions, and that
    // emptiness is the answer rather than a missing seed row.
    expect(codes({ businessConstitutionCode: "proprietorship" })).toEqual(["lap", "bl_unsecured"]);
  });

  it("treats an unloaded eligibility list as admitting anybody", () => {
    // Absent is not empty. A caller that did not load the junction must not
    // silently filter the whole catalogue away.
    const partial = product({ code: "unknown" });
    const { employmentTypeCodes: _omitted, ...rest } = partial;
    expect(matchesFilter({ ...rest }, { employmentTypeCode: "salaried", on: TODAY })).toBe(true);
  });

  it("splits the catalogue on whether a property is required", () => {
    expect(codes({ requiresProperty: true })).toEqual(["lap"]);
    expect(codes({ requiresProperty: false })).toEqual(["pl", "bl_unsecured"]);
  });

  it("treats an optional GST requirement as not required", () => {
    expect(isRequired("optional")).toBe(false);
    expect(codes({ requiresGst: true })).toEqual(["bl_unsecured"]);
  });

  it("an empty filter narrows nothing", () => {
    expect(codes({ query: "" })).toEqual(["lap", "pl", "bl_unsecured"]);
  });
});

describe("presentation", () => {
  it("says years where a tenure divides into them", () => {
    expect(describeTenure(product({ minTenureMonths: 36, maxTenureMonths: 240 }))).toBe(
      "3 years – 20 years",
    );
  });

  it("says months where it does not", () => {
    expect(describeTenure(product({ minTenureMonths: 1, maxTenureMonths: 18 }))).toBe(
      "1 month – 18 months",
    );
  });

  it("collapses a single-value range", () => {
    expect(describeTenure(product({ minTenureMonths: 12, maxTenureMonths: 12 }))).toBe("1 year");
  });

  it("says nothing when nothing is stated", () => {
    const { minTenureMonths: _a, maxTenureMonths: _b, ...bare } = product();
    expect(describeTenure(bare)).toBeUndefined();
  });

  it("writes money in lakhs and crores, as everyone using this says it", () => {
    expect(describeAmount(500000)).toBe("₹5 L");
    expect(describeAmount(15000000)).toBe("₹1.5 Cr");
    expect(describeAmount(20000)).toBe("₹20 K");
    expect(describeAmount(750)).toBe("₹750");
  });

  it("renders an amount range", () => {
    expect(describeAmountRange(product())).toBe("₹5 L – ₹10 Cr");
  });
});
