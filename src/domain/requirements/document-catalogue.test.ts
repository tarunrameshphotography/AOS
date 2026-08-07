/**
 * The document catalogue, held to being ONE catalogue.
 *
 * Two kinds of test live here.
 *
 * The first kind is about wording: does a row read like something a telecaller
 * can say out loud, in the words the customer will use back? Those tests fail
 * when the catalogue stops being useful on the phone.
 *
 * The second kind — everything under "structure" — exists because this file
 * has been edited across many milestones, and every time it was, the failure
 * mode was the same: a document defined twice. A second definition of the same
 * document makes the checklist ask for one thing twice and look broken to the
 * person reading it out, and it is invisible in review because both halves look
 * correct on their own. These tests fail the build the moment a code, an
 * object, a display order, a customer-facing name, an owner, a category or a
 * piece of period metadata is written twice or written wrong. They are meant to
 * be impossible to regress past, not merely informative.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CUSTOM_DOCUMENT_TYPE_CODE,
  DOCUMENT_CATALOGUE,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_HINTS,
  DOCUMENT_CATEGORY_LABELS,
  DOCUMENT_OWNER_KINDS,
  DOCUMENT_TYPES_BY_CODE,
  FINANCIAL_YEAR_DOCUMENT_TYPES,
  allDocumentTypeCodes,
  assessmentYearLabel,
  documentRowLabel,
  documentTypeByCode,
  isFinancialYearScoped,
} from "./document-catalogue.js";

/** Every value appearing more than once, with the codes that produced it. */
function duplicatesBy<T>(key: (type: (typeof DOCUMENT_CATALOGUE)[number]) => T): [T, string[]][] {
  const byKey = new Map<T, string[]>();
  for (const type of DOCUMENT_CATALOGUE) {
    byKey.set(key(type), [...(byKey.get(key(type)) ?? []), type.code]);
  }
  return [...byKey.entries()].filter(([, codes]) => codes.length > 1);
}

describe("the document catalogue — structure", () => {
  /**
   * The guard the consolidation milestone was for, held permanently open.
   *
   * `DOCUMENT_CATALOGUE` is the only list. If a future milestone adds a second
   * array and concatenates it — which is how the base/engine split happened —
   * a code appearing twice is what gives it away here.
   */
  it("defines every document code exactly once", () => {
    expect(duplicatesBy((type) => type.code)).toEqual([]);
    expect(DOCUMENT_TYPES_BY_CODE.size).toBe(DOCUMENT_CATALOGUE.length);
  });

  /**
   * Not the same test as the one above. Two entries may carry distinct codes
   * and still be the same document object reached twice — which is what a
   * spread of one list into another produces.
   */
  it("holds every document as its own object, never the same object twice", () => {
    const seen = new Set<object>();
    for (const type of DOCUMENT_CATALOGUE) {
      expect(seen.has(type), `${type.code} appears twice as the same object`).toBe(false);
      seen.add(type);
    }
    expect(seen.size).toBe(DOCUMENT_CATALOGUE.length);
  });

  it("gives no two documents the same display order, so the checklist order is decided", () => {
    expect(duplicatesBy((type) => type.displayOrder)).toEqual([]);
  });

  /**
   * The file is written in display order and reads in display order. A new
   * document appended to the bottom with an order that belongs in the middle
   * is how the list stops matching itself.
   */
  it("is written in display order", () => {
    const orders = DOCUMENT_CATALOGUE.map((type) => type.displayOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  /**
   * The duplicate a reader CAN see. Two rows reading "Bank Statement" are two
   * rows nobody on a call can tell apart, whatever their codes say.
   */
  it("gives no two documents the same customer-facing name", () => {
    expect(duplicatesBy((type) => type.name)).toEqual([]);
  });

  it("gives every document a category the UI can group it under", () => {
    const invalid = DOCUMENT_CATALOGUE.filter(
      (type) => !(DOCUMENT_CATEGORIES as readonly string[]).includes(type.category),
    ).map((type) => type.code);

    expect(invalid).toEqual([]);
  });

  it("gives every category a heading and a hint, so no group renders bare", () => {
    for (const category of DOCUMENT_CATEGORIES) {
      expect(DOCUMENT_CATEGORY_LABELS[category]?.length ?? 0).toBeGreaterThan(0);
      expect(DOCUMENT_CATEGORY_HINTS[category]?.length ?? 0).toBeGreaterThan(0);
    }
    expect(Object.keys(DOCUMENT_CATEGORY_LABELS).sort()).toEqual([...DOCUMENT_CATEGORIES].sort());
    expect(Object.keys(DOCUMENT_CATEGORY_HINTS).sort()).toEqual([...DOCUMENT_CATEGORIES].sort());
  });

  /**
   * Owner kind decides which subject a requirement is raised against (ADR-007).
   * A document owned by nobody real generates a row attached to nothing.
   */
  it("gives every document a real owner", () => {
    const invalid = DOCUMENT_CATALOGUE.filter(
      (type) => !(DOCUMENT_OWNER_KINDS as readonly string[]).includes(type.ownerKind),
    ).map((type) => type.code);

    expect(invalid).toEqual([]);
  });

  it("resolves every code through the map, and unknown codes to nothing", () => {
    for (const code of allDocumentTypeCodes()) {
      expect(documentTypeByCode(code)?.code).toBe(code);
    }
    expect(documentTypeByCode("no_such_document")).toBeUndefined();
    expect(allDocumentTypeCodes()).toHaveLength(DOCUMENT_CATALOGUE.length);
  });

  it("has a real definition behind the code hand-added requirements point at", () => {
    expect(documentTypeByCode(CUSTOM_DOCUMENT_TYPE_CODE)).toBeDefined();
  });

  /**
   * The barrel is the other place a definition can be written twice: an export
   * listed under both its old and its new name is two names for one thing, and
   * callers then drift apart on which they use.
   */
  it("exports every catalogue name from the barrel exactly once", () => {
    const barrel = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    // `\r?$` on purpose: the repo is checked out with CRLF endings on Windows,
    // and a `$`-anchored pattern that forgets it matches nothing at all — a
    // guard that passes because it read no exports is worse than no guard.
    const exported = [...barrel.matchAll(/^ {2}(?:type )?([A-Za-z_][A-Za-z0-9_]*),\r?$/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(exported, "read no exports out of index.ts").not.toHaveLength(0);
    expect(exported).toContain("DOCUMENT_CATALOGUE");

    const seenOnce = new Set<string>();
    const duplicated = exported.filter((name) => {
      const already = seenOnce.has(name);
      seenOnce.add(name);
      return already;
    });

    expect(duplicated).toEqual([]);
  });
});

describe("the document catalogue — period metadata", () => {
  /**
   * A recurring document rendered without its year is why two years of GST
   * returns once looked like one document asked for twice.
   */
  it("names the period of every document that recurs per year", () => {
    for (const code of Object.keys(FINANCIAL_YEAR_DOCUMENT_TYPES)) {
      expect(documentTypeByCode(code)?.periodKind, `${code} has no periodKind`).toBeDefined();
    }
  });

  it("only names a period kind on a document that actually carries a period", () => {
    const contradictory = DOCUMENT_CATALOGUE.filter(
      (type) => type.periodKind !== undefined && !type.requiresPeriod,
    ).map((type) => type.code);

    expect(contradictory).toEqual([]);
  });

  it("only asks for trailing years of a document that actually carries a period", () => {
    const contradictory = DOCUMENT_CATALOGUE.filter(
      (type) => type.defaultFinancialYears !== undefined && !type.requiresPeriod,
    ).map((type) => type.code);

    expect(contradictory).toEqual([]);
  });

  it("asks for a positive whole number of trailing years, or does not ask at all", () => {
    for (const [code, count] of Object.entries(FINANCIAL_YEAR_DOCUMENT_TYPES)) {
      expect(Number.isInteger(count), `${code} asks for ${count} years`).toBe(true);
      expect(count, `${code} asks for ${count} years`).toBeGreaterThan(0);
    }
  });

  /**
   * `FINANCIAL_YEAR_DOCUMENT_TYPES` is derived from the catalogue rather than
   * written out beside it — this asserts the derivation, so a hand-written copy
   * reappearing anywhere fails rather than silently drifting.
   */
  it("derives the recurring set from the catalogue and nowhere else", () => {
    expect(Object.keys(FINANCIAL_YEAR_DOCUMENT_TYPES).sort()).toEqual(
      DOCUMENT_CATALOGUE.filter((type) => type.defaultFinancialYears !== undefined)
        .map((type) => type.code)
        .sort(),
    );
  });

  it("covers the returns, the accounts, the banking and the tax records", () => {
    expect(Object.keys(FINANCIAL_YEAR_DOCUMENT_TYPES).sort()).toEqual(
      [
        "audit_report",
        "balance_sheet",
        "bank_statement",
        "form_16",
        "form_26as",
        "gst_returns",
        "itr",
        "org_bank_statement",
        "org_itr",
        "profit_and_loss",
      ].sort(),
    );
  });

  it("reports scoped and unscoped types correctly", () => {
    expect(isFinancialYearScoped("itr")).toBe(true);
    expect(isFinancialYearScoped("pan_card")).toBe(false);
  });

  it("names the returns by assessment year, because that is the number on them", () => {
    const assessmentYearScoped = DOCUMENT_CATALOGUE.filter(
      (type) => type.periodKind === "assessment_year",
    ).map((type) => type.code);

    expect(assessmentYearScoped).toContain("itr");
    expect(assessmentYearScoped).toContain("org_itr");
    expect(assessmentYearScoped).toContain("form_16");
    expect(assessmentYearScoped).toContain("form_26as");
  });

  it("puts the period in the row's own name, so two years never read as one document twice", () => {
    expect(documentRowLabel("GST 3B", "2025-26", "financial_year")).toBe("GST 3B – FY 2025-26");
    expect(documentRowLabel("GST 3B", "2024-25", "financial_year")).toBe("GST 3B – FY 2024-25");
    // FY 2024-25 is assessed in AY 2025-26 — the number on the return the
    // customer is holding.
    expect(documentRowLabel("Business ITR", "2024-25", "assessment_year")).toBe(
      "Business ITR – AY 2025-26",
    );
    // A document with no period is left exactly as it is.
    expect(documentRowLabel("PAN Card", undefined, undefined)).toBe("PAN Card");
  });

  it("reads an assessment year one ahead of the financial year", () => {
    expect(assessmentYearLabel("2024-25")).toBe("2025-26");
    expect(assessmentYearLabel("2019-20")).toBe("2020-21");
  });
});

describe("the document catalogue as a telecaller reads it", () => {
  it("gives every document a helper description, because the person asking may be in their first week", () => {
    const undescribed = DOCUMENT_CATALOGUE.filter(
      (type) => type.description.trim().length < 20,
    ).map((type) => type.code);

    expect(undescribed).toEqual([]);
  });

  it("carries the local name alongside the official one for the documents Tamil Nadu calls something else", () => {
    expect(documentTypeByCode("encumbrance_cert")?.localName).toMatch(/villangam/i);
    expect(documentTypeByCode("udyam_certificate")?.localName).toMatch(/udyog aadhaar/i);
    expect(documentTypeByCode("credit_bureau_consent")?.localName).toMatch(/cibil/i);
  });

  /**
   * A local name that is only the official name reworded tells the telecaller
   * nothing and reads as noise on the row ("GST Returns (GSTR-3B) (GST 3B)").
   * Where the form number IS the recognisable name, it belongs in the name.
   */
  it("never repeats the official name back as the local name", () => {
    const noisy = DOCUMENT_CATALOGUE.filter(
      (type) => type.localName && type.name.toLowerCase().includes(type.localName.toLowerCase()),
    ).map((type) => type.code);

    expect(noisy).toEqual([]);
  });

  it("calls documents what the customer calls them", () => {
    expect(documentTypeByCode("credit_bureau_consent")?.name).toBe("Loan Consent Form");
    expect(documentTypeByCode("application_form")?.name).toBe("Loan Application Form");
    expect(documentTypeByCode("photograph")?.name).toBe("Passport Size Photograph");
    expect(documentTypeByCode("gst_certificate")?.name).toBe(
      "GST Registration Certificate (GST REG-06)",
    );
    expect(documentTypeByCode("patta_chitta")?.name).toBe("Patta & Chitta");
  });

  it("lists what counts as address proof, because that is the question every collection call gets", () => {
    const examples = (documentTypeByCode("address_proof")?.examples ?? []).map((e) =>
      e.toLowerCase(),
    );

    for (const example of ["eb bill", "gas bill", "ration card", "passport", "driving licence"]) {
      expect(examples).toContain(example);
    }
  });

  /** An empty or repeating example list is worse than none: it reads as a bug. */
  it("never carries an empty or repeating list of examples", () => {
    for (const type of DOCUMENT_CATALOGUE) {
      if (!type.examples) continue;
      expect(type.examples.length, `${type.code} has an empty examples list`).toBeGreaterThan(1);
      expect(new Set(type.examples).size, `${type.code} repeats an example`).toBe(
        type.examples.length,
      );
    }
  });
});
