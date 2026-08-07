import { describe, expect, it } from "vitest";

import {
  financialYearLabel,
  financialYearOf,
  financialYearStartYear,
  recentFinancialYears,
} from "./financial-year.js";

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

