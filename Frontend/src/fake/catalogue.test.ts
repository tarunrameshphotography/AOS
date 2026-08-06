/**
 * The seeded lending product catalogue must actually hang together.
 *
 * Every product points at four master-data tables and three junction lists by
 * id. A typo in the seed is invisible until someone opens the screen and
 * finds a blank Security field, so it is checked here instead — the same
 * reasoning that made requirement generation worth testing in a prototype.
 */

import { describe, expect, it } from "vitest";

import { filterProducts } from "@domain/products/index.js";

import { buildSeed } from "./seed.js";
import { lendingProductsAsDomain } from "./store.js";

const db = buildSeed();

describe("the seeded catalogue", () => {
  it("has a product for every category, and a category for every product", () => {
    expect(db.loanProducts.length).toBeGreaterThan(30);
    for (const product of db.loanProducts) {
      expect(
        db.loanCategories.find((c) => c.id === product.loanCategoryId),
        `${product.code} points at no loan category`,
      ).toBeDefined();
    }
    const used = new Set(db.loanProducts.map((p) => p.loanCategoryId));
    for (const category of db.loanCategories) {
      expect(used.has(category.id), `${category.code} has no products`).toBe(true);
    }
  });

  it("gives every product a unique code and a name", () => {
    const codes = db.loanProducts.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const product of db.loanProducts) {
      expect(product.name, `${product.code} has no name`).toBeTruthy();
      expect(product.description, `${product.code} has no description`).toBeTruthy();
    }
  });

  it("resolves every master-data reference it makes", () => {
    for (const product of db.loanProducts) {
      expect(db.securityTypes.find((s) => s.id === product.securityTypeId)).toBeDefined();
      expect(
        db.requirementApplicabilities.find((r) => r.id === product.propertyRequirementId),
      ).toBeDefined();
      expect(
        db.requirementApplicabilities.find((r) => r.id === product.gstRequirementId),
      ).toBeDefined();
      for (const id of product.borrowerTypeIds ?? []) {
        expect(db.borrowerTypes.find((b) => b.id === id), `${product.code}`).toBeDefined();
      }
      for (const id of product.employmentTypeIds ?? []) {
        expect(db.employmentTypes.find((e) => e.id === id), `${product.code}`).toBeDefined();
      }
      for (const id of product.businessConstitutionIds ?? []) {
        expect(db.businessConstitutions.find((c) => c.id === id), `${product.code}`).toBeDefined();
      }
    }
  });

  it("keeps the legacy free-text columns populated, so nothing reading them breaks", () => {
    for (const product of db.loanProducts) {
      expect(product.category, `${product.code}`).toBeTruthy();
      expect(product.variant, `${product.code}`).toBeTruthy();
    }
  });

  it("keeps ranges the right way round", () => {
    for (const product of db.loanProducts) {
      const { minTenureMonths: minT, maxTenureMonths: maxT, minAmount, maxAmount } = product;
      if (minT !== undefined && maxT !== undefined) expect(maxT).toBeGreaterThanOrEqual(minT);
      if (minAmount !== undefined && maxAmount !== undefined) {
        expect(maxAmount).toBeGreaterThanOrEqual(minAmount);
      }
    }
  });

  it("still points the seeded cases at products that exist", () => {
    for (const loanCase of db.cases) {
      expect(
        db.loanProducts.find((p) => p.id === loanCase.loanProductId),
        `${loanCase.caseNumber} points at a product that is not in the catalogue`,
      ).toBeDefined();
    }
  });
});

describe("the catalogue through the domain layer", () => {
  const products = lendingProductsAsDomain(db);

  it("projects every product into the domain shape", () => {
    expect(products).toHaveLength(db.loanProducts.length);
    expect(products.every((p) => p.categoryCode !== undefined)).toBe(true);
  });

  it("finds a product by a word from its name", () => {
    const found = filterProducts(products, { query: "lease rental" });
    expect(found.map((p) => p.code)).toEqual(["lap_lrd"]);
  });

  it("narrows to the products a salaried applicant can be offered", () => {
    const salaried = filterProducts(products, { employmentTypeCode: "salaried" }).map((p) => p.code);
    expect(salaried).toContain("pl");
    expect(salaried).toContain("hl_purchase");
    // Working capital is a business facility; a payslip is not how it is
    // assessed.
    expect(salaried).not.toContain("bl_working_capital");
  });

  it("separates the products that need a property from those that do not", () => {
    const secured = filterProducts(products, { requiresProperty: true }).map((p) => p.code);
    expect(secured).toContain("lap");
    expect(secured).not.toContain("pl");
    expect(secured).not.toContain("gl_gold");
  });

  it("offers no NRI product to a resident, and no resident-only product to an NRI", () => {
    const nri = filterProducts(products, { borrowerTypeCode: "nri_individual" }).map((p) => p.code);
    expect(nri).toContain("hl_nri");
    expect(nri).not.toContain("pl");
  });
});
