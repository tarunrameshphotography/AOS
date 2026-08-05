import { describe, expect, it } from "vitest";
import { formatCaseNumber, parseCaseNumber, resolveCaseNumberInput } from "./case-number.js";

describe("formatCaseNumber", () => {
  it("renders the canonical form", () => {
    expect(formatCaseNumber({ year: 2026, sequence: 42 })).toBe("AL-2026-00042");
  });

  it("pads to five digits", () => {
    expect(formatCaseNumber({ year: 2026, sequence: 1 })).toBe("AL-2026-00001");
  });

  it("widens rather than truncating past five digits", () => {
    // A collision would be silent and permanent; a six-digit number is merely ugly.
    expect(formatCaseNumber({ year: 2026, sequence: 100_000 })).toBe("AL-2026-100000");
  });

  it("refuses a zero or negative sequence", () => {
    expect(() => formatCaseNumber({ year: 2026, sequence: 0 })).toThrow(RangeError);
  });
});

describe("parseCaseNumber", () => {
  it("round-trips the canonical form", () => {
    expect(parseCaseNumber("AL-2026-00042")).toEqual({ year: 2026, sequence: 42 });
  });

  it("accepts lowercase and surrounding whitespace", () => {
    expect(parseCaseNumber("  al-2026-00042 ")).toEqual({ year: 2026, sequence: 42 });
  });

  it("returns null for anything else rather than throwing", () => {
    expect(parseCaseNumber("Ravi Kumar")).toBeNull();
    expect(parseCaseNumber("AL-26-42")).toBeNull();
  });
});

/**
 * The formats people actually type. `Identity Resolution.md` Part 6 originally
 * specified a `#1042` handle; ADR-024 replaces it, and all of these must still
 * find the case.
 */
describe("resolveCaseNumberInput", () => {
  it("accepts the full number", () => {
    expect(resolveCaseNumberInput("AL-2026-00042", 2026)).toBe("AL-2026-00042");
  });

  it("accepts year and sequence without the prefix", () => {
    expect(resolveCaseNumberInput("2026-00042", 2026)).toBe("AL-2026-00042");
  });

  it("accepts a padded sequence alone, using the context year", () => {
    expect(resolveCaseNumberInput("00042", 2026)).toBe("AL-2026-00042");
  });

  it("accepts an unpadded sequence alone", () => {
    expect(resolveCaseNumberInput("42", 2026)).toBe("AL-2026-00042");
  });

  it("accepts the legacy hash handle", () => {
    expect(resolveCaseNumberInput("#1042", 2026)).toBe("AL-2026-01042");
  });

  it("treats a bare four-digit number as a sequence, not a year", () => {
    expect(resolveCaseNumberInput("2026", 2026)).toBe("AL-2026-02026");
  });

  it("returns null for ordinary text so search falls through", () => {
    expect(resolveCaseNumberInput("madurai", 2026)).toBeNull();
    expect(resolveCaseNumberInput("  ", 2026)).toBeNull();
  });
});
