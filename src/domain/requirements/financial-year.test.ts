import { describe, expect, it } from "vitest";

import {
  financialYearLabel,
  financialYearOf,
  financialYearStartYear,
  recentCompletedFinancialYears,
  recentFinancialYears,
} from "./financial-year.js";
import { assessmentYearLabel } from "./document-catalogue.js";

describe("financialYearStartYear", () => {
  it("puts a January date in the financial year that started the previous April", () => {
    expect(financialYearStartYear(new Date("2025-01-15T00:00:00Z"))).toBe(2024);
  });

  it("puts a March 31 date in the financial year that started the previous April", () => {
    expect(financialYearStartYear(new Date("2025-03-31T00:00:00Z"))).toBe(2024);
  });

  it("puts an April 1 date in the financial year starting that same day", () => {
    expect(financialYearStartYear(new Date("2025-04-01T00:00:00Z"))).toBe(2025);
  });

  it("puts a December date in the financial year that started that same calendar year", () => {
    expect(financialYearStartYear(new Date("2025-12-25T00:00:00Z"))).toBe(2025);
  });

  it("switches on 31 March / 1 April at the FY boundary", () => {
    expect(financialYearStartYear(new Date("2026-03-31T00:00:00Z"))).toBe(2025);
    expect(financialYearStartYear(new Date("2026-04-01T00:00:00Z"))).toBe(2026);
    expect(financialYearStartYear(new Date("2027-03-31T00:00:00Z"))).toBe(2026);
    expect(financialYearStartYear(new Date("2027-04-01T00:00:00Z"))).toBe(2027);
  });
});

describe("financialYearLabel", () => {
  it("formats a normal year", () => {
    expect(financialYearLabel(2024)).toBe("2024-25");
  });

  it("rolls the suffix over at the turn of the century", () => {
    expect(financialYearLabel(2099)).toBe("2099-00");
  });
});

describe("financialYearOf", () => {
  it("returns the correct start and end dates and label", () => {
    const fy = financialYearOf(new Date("2024-08-05T00:00:00Z"));
    expect(fy).toEqual({ startDate: "2024-04-01", endDate: "2025-03-31", label: "2024-25" });
  });
});

describe("recentFinancialYears", () => {
  it("returns the requested count, most recent first, including the current FY", () => {
    const years = recentFinancialYears(3, new Date("2026-08-05T00:00:00Z"));
    expect(years.map((y) => y.label)).toEqual(["2026-27", "2025-26", "2024-25"]);
  });

  it("returns an empty array for a non-positive count", () => {
    expect(recentFinancialYears(0)).toEqual([]);
    expect(recentFinancialYears(-1)).toEqual([]);
  });

  it("defaults to the current date when asOf is omitted", () => {
    const [first] = recentFinancialYears(1);
    expect(first).toEqual(financialYearOf(new Date()));
  });
});

describe("recentCompletedFinancialYears", () => {
  it("excludes the current, still-open, financial year", () => {
    const years = recentCompletedFinancialYears(3, new Date("2026-08-09T00:00:00Z"));
    expect(years.map((y) => y.label)).toEqual(["2025-26", "2024-25", "2023-24"]);
  });

  it("shifts on 1 April, the day the previously-current FY completes", () => {
    const beforeBoundary = recentCompletedFinancialYears(1, new Date("2026-03-31T00:00:00Z"));
    expect(beforeBoundary.map((y) => y.label)).toEqual(["2024-25"]);

    const afterBoundary = recentCompletedFinancialYears(1, new Date("2026-04-01T00:00:00Z"));
    expect(afterBoundary.map((y) => y.label)).toEqual(["2025-26"]);
  });

  it("returns an empty array for a non-positive count", () => {
    expect(recentCompletedFinancialYears(0)).toEqual([]);
    expect(recentCompletedFinancialYears(-1)).toEqual([]);
  });

  it("never yields a financial year that has not yet started, regardless of the calendar year", () => {
    for (const isoDate of ["2026-08-09", "2030-01-01", "2040-06-15"]) {
      const asOf = new Date(`${isoDate}T00:00:00Z`);
      const years = recentCompletedFinancialYears(3, asOf);
      for (const fy of years) {
        expect(fy.endDate < isoDate).toBe(true);
      }
    }
  });
});

describe("ITR assessment-year requirement generation (no future years)", () => {
  it("resolves 'previous 3 assessment years' to three completed AYs, never the in-progress one", () => {
    const asOf = new Date("2026-08-09T00:00:00Z");
    const ayLabels = recentCompletedFinancialYears(3, asOf).map((fy) =>
      assessmentYearLabel(fy.label),
    );
    expect(ayLabels).toEqual(["2026-27", "2025-26", "2024-25"]);
    // The in-progress FY 2026-27 would assess as AY 2027-28 — must not appear.
    expect(ayLabels).not.toContain("2027-28");
    expect(ayLabels).not.toContain("2028-29");
    expect(ayLabels).not.toContain("2029-30");
  });
});

