/**
 * The seeded lender catalogue must actually hang together — and must not have
 * quietly invented anything.
 *
 * Two different things are checked here. The first is structural, the same
 * reasoning that made the lending product catalogue worth testing: every
 * lender points at a lender type, every branch at a parent institution, every
 * supported product at a real lending product, and a typo in the seed is
 * invisible until someone opens the screen and finds a blank field.
 *
 * The second is a matter of record. The milestone brief was explicit — use
 * real institutions, never invent one, and leave a field blank rather than
 * fabricate it. That is a promise a test can keep: no seeded relationship
 * managers, no seeded phone numbers, no seeded turnaround figures, no seeded
 * opinions attributed to the team. If somebody later adds a plausible-looking
 * "7 days" to the seed, this fails and asks them where they got it.
 */

import { describe, expect, it } from "vitest";

import { branchesOf, filterLenders, supportedProductCodes } from "@domain/lenders/index.js";

import { buildSeed } from "./seed.js";
import { lendersAsDomain } from "./store.js";

const db = buildSeed();
const view = lendersAsDomain(db);

describe("the seeded lender catalogue", () => {
  it("holds the lenders Amaze realistically works with", () => {
    expect(db.lenderProfiles.length).toBeGreaterThan(25);
    const names = db.organisations
      .filter((org) => org.roles.includes("lender"))
      .map((org) => org.canonicalName);
    for (const expected of [
      "State Bank of India",
      "Indian Bank",
      "Karur Vysya Bank",
      "Tamilnad Mercantile Bank",
      "Bajaj Finance",
      "Cholamandalam Investment and Finance Company",
      "LIC Housing Finance",
      "Aptus Value Housing Finance India",
    ]) {
      expect(names, `${expected} is missing from the catalogue`).toContain(expected);
    }
  });

  it("gives every lender a unique short code, a type and a head office", () => {
    const codes = db.lenderProfiles.map((profile) => profile.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const profile of db.lenderProfiles) {
      expect(profile.code, "a lender has no short code").toBeTruthy();
      expect(
        db.lenderTypes.find((type) => type.id === profile.lenderTypeId),
        `${profile.code} points at no lender type`,
      ).toBeDefined();
      expect(profile.headOfficeCity, `${profile.code} has no head office`).toBeTruthy();
    }
  });

  // Both are kept and both populated, so nothing reading the older enum
  // breaks. A Small Finance Bank is recorded as a bank — a widening, never a
  // lie (Database/migrations/0019).
  it("keeps the legacy lender type enum consistent with the master-data one", () => {
    for (const profile of db.lenderProfiles) {
      const typeCode = db.lenderTypes.find((t) => t.id === profile.lenderTypeId)?.code;
      const expected =
        typeCode === "nbfc" ? "nbfc" : typeCode === "housing_finance_company" ? "hfc" : "bank";
      expect(profile.lenderType, `${profile.code} disagrees with its lender type`).toBe(expected);
    }
  });

  it("hangs every branch off a real institution, with real geography", () => {
    for (const branch of db.bankBranches) {
      const organisation = db.organisations.find((org) => org.id === branch.organisationId);
      expect(organisation, "a branch row has no organisation").toBeDefined();
      expect(organisation?.roles).toContain("branch");
      if (branch.districtId !== undefined) {
        expect(
          db.districts.find((d) => d.id === branch.districtId),
          "a branch points at no district",
        ).toBeDefined();
      }
      if (branch.cityId !== undefined) {
        expect(db.cities.find((c) => c.id === branch.cityId)).toBeDefined();
      }
    }
  });

  it("points every supported product at a lending product it does not redefine", () => {
    expect(db.bankProducts.length).toBeGreaterThan(50);
    for (const entry of db.bankProducts) {
      expect(
        db.loanProducts.find((p) => p.id === entry.loanProductId),
        `${entry.name} points at no lending product`,
      ).toBeDefined();
      expect(db.organisations.find((o) => o.id === entry.organisationId)).toBeDefined();
    }
  });

  // Lakshmi Vilas Bank was amalgamated into DBS Bank India in November 2020.
  // Inactive rather than absent, so older cases naming it still resolve —
  // and never selectable for a new one.
  it("carries the legacy lender as inactive rather than as a live option", () => {
    const lvb = db.organisations.find((org) => org.canonicalName === "Lakshmi Vilas Bank");
    expect(lvb?.isActive).toBe(false);
    expect(filterLenders(view.institutions, {}).map((l) => l.code)).not.toContain("lvb");
    expect(filterLenders(view.institutions, { includeInactive: true }).map((l) => l.code)).toContain(
      "lvb",
    );
  });

  // HDFC Ltd merged into HDFC Bank in July 2023. One institution, and the
  // former name reached through search — which is the entire reason lenders
  // are organisations (ADR-014).
  it("does not carry a second entity for a merged institution", () => {
    const hdfc = view.institutions.filter((l) => l.name.toLowerCase().includes("hdfc"));
    expect(hdfc).toHaveLength(1);
    expect(hdfc[0]?.notes).toContain("1 July 2023");
  });
});

describe("the projection the screen filters through", () => {
  it("resolves every institution and branch into the domain shape", () => {
    expect(view.institutions).toHaveLength(db.lenderProfiles.length);
    expect(view.branches).toHaveLength(db.bankBranches.length);
    for (const branch of view.branches) {
      expect(
        view.institutions.find((l) => l.code === branch.institutionCode),
        `${branch.name} resolves to no institution`,
      ).toBeDefined();
    }
  });

  it("finds a Coimbatore lender that does loans against property", () => {
    const matches = filterLenders(
      view.institutions,
      { districtCode: "coimbatore", lendingProductCode: "lap" },
      { branches: view.branches, supportedProducts: view.supportedProducts },
    );
    expect(matches.length).toBeGreaterThan(10);
  });

  it("gives a housing finance company home loans and no business loans", () => {
    const aptus = view.institutions.find((l) => l.code === "aptus");
    expect(aptus).toBeDefined();
    const codes = supportedProductCodes(aptus!, {
      branches: view.branches,
      supportedProducts: view.supportedProducts,
    });
    expect(codes.has("hl_purchase")).toBe(true);
    expect(codes.has("bl_working_capital")).toBe(false);
  });

  it("gives every active lender a branch to lodge at", () => {
    for (const institution of view.institutions.filter((l) => l.isActive)) {
      expect(
        branchesOf(institution, view.branches).length,
        `${institution.code} has no branch`,
      ).toBeGreaterThan(0);
    }
  });
});

describe("what the seed deliberately does not claim", () => {
  // Inventing the names of bank employees would put fictional people into an
  // operational contact list, and the first person to ring one would stop
  // trusting the whole catalogue.
  it("invents no relationship managers", () => {
    expect(db.bankContacts).toEqual([]);
  });

  // "Excellent for textile businesses" is only worth storing when it is
  // Amaze's own observation. A seeded one would be an invented opinion
  // attributed to the team — worse than an invented phone number, because
  // nobody can check it.
  it("invents no institutional knowledge", () => {
    expect(db.lenderInsights).toEqual([]);
    for (const profile of db.lenderProfiles) {
      expect(profile.knownStrengths, `${profile.code} has invented strengths`).toBeUndefined();
      expect(profile.knownLimitations).toBeUndefined();
      expect(profile.commonRejectionPatterns).toBeUndefined();
      expect(profile.preferredCustomerSegments).toBeUndefined();
    }
  });

  it("invents no operational details it could not know", () => {
    expect(db.lenderSubmissionRules).toEqual([]);
    for (const profile of db.lenderProfiles) {
      expect(
        profile.typicalTurnaroundDays,
        `${profile.code} has an invented turnaround`,
      ).toBeUndefined();
    }
    for (const branch of db.bankBranches) {
      expect(branch.contactNumber, "a branch has an invented phone number").toBeUndefined();
      expect(branch.email).toBeUndefined();
      expect(branch.addressLine).toBeUndefined();
    }
    for (const entry of db.bankProducts) {
      expect(entry.minAmount, `${entry.name} has an invented limit`).toBeUndefined();
      expect(entry.maxAmount).toBeUndefined();
      expect(entry.indicativeRate).toBeUndefined();
    }
  });
});
