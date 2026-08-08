/**
 * The checklist a telecaller is handed, per product family.
 *
 * These are not unit tests of the engine — `src/domain/requirements` already
 * has those. They are an audit of the thing a human actually reads: run the
 * real seed, open one case of each product family Amaze sells, and assert the
 * result is something you could read down a phone without apologising for it.
 *
 * The one that matters most is `no two rows say the same thing`. A checklist
 * that appears to ask for the same document twice is the single fastest way
 * to lose a user's trust in the whole system — they stop believing the rest
 * of the list too — and it is invisible to every test that checks document
 * CODES, because the duplication is in what the rows are CALLED.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DOCUMENT_CATEGORIES,
  documentRowLabel,
} from "@domain/requirements/document-catalogue.js";
import { financialYearOf } from "@domain/requirements/financial-year.js";

import { InMemoryStorageAdapter } from "./storage.mock.js";

const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => void backing.set(key, value),
  removeItem: (key: string) => void backing.delete(key),
  clear: () => backing.clear(),
  key: () => null,
  get length() {
    return backing.size;
  },
} as Storage;

vi.doMock("./storage.js", () => ({ storageAdapter: new InMemoryStorageAdapter() }));

const { createCase, getDb, resetDatabase, addCaseProperty, updatePartyProfile } =
  await import("./store.js");

interface Row {
  label: string;
  subject: string;
  category: string;
}

/** Open a case of one product and return its checklist as a human reads it. */
function checklistFor(
  productCode: string,
  options: { property?: boolean; employment?: string } = {},
): Row[] {
  const db = getDb();
  const userId = db.users[0]?.id;
  const product = db.loanProducts.find((p) => p.code === productCode);
  if (!userId || !product) {
    throw new Error(`test setup: no seeded user, or no product ${productCode}`);
  }

  const caseId = createCase({ newApplicantName: "Test Customer", loanProductId: product.id }, userId);

  if (options.property) {
    addCaseProperty(
      caseId,
      { role: "collateral", newPropertyLocality: "Saravanampatti", newPropertyCity: "Coimbatore" },
      userId,
    );
  }
  if (options.employment) {
    const party = getDb().caseParties.find((p) => p.caseId === caseId && p.role === "applicant");
    const type = getDb().employmentTypes.find((e) => e.code === options.employment);
    if (party && type) updatePartyProfile(party.id, { employmentTypeId: type.id }, userId);
  }

  const now = getDb();
  return now.requirements
    .filter((r) => r.caseId === caseId && r.status !== "not_applicable")
    .map((r) => {
      const type = now.documentTypes.find((t) => t.id === r.documentTypeId);
      const financialYear = r.periodStart
        ? financialYearOf(new Date(r.periodStart)).label
        : undefined;
      return {
        label: r.isCustom
          ? (r.customName ?? "Document")
          : documentRowLabel(type?.name ?? "Document", financialYear, type?.periodKind),
        subject: r.requiredOfCasePartyId ?? r.requiredOfCasePropertyId ?? "case",
        category: (r.isCustom ? r.customCategory : type?.category) ?? "additional",
      };
    });
}

const FAMILIES: Array<{ label: string; code: string; property?: boolean; employment?: string }> = [
  { label: "Business Loan", code: "bl_working_capital", employment: "business_owner" },
  { label: "Home Loan", code: "hl_purchase", property: true, employment: "salaried" },
  { label: "Mortgage / LAP", code: "lap_commercial", property: true, employment: "business_owner" },
  { label: "Vehicle Loan", code: "vl_new_car", employment: "salaried" },
  { label: "Personal Loan", code: "pl", employment: "salaried" },
  { label: "Education Loan", code: "el_abroad", employment: "salaried" },
];

describe("the checklist every product family generates", () => {
  for (const family of FAMILIES) {
    describe(family.label, () => {
      it("says no two rows the same, for the same subject", () => {
        resetDatabase();
        const rows = checklistFor(family.code, family);

        const seen = new Map<string, number>();
        for (const row of rows) {
          const key = `${row.label} — ${row.subject}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }

        expect([...seen.entries()].filter(([, count]) => count > 1)).toEqual([]);
      });

      it("puts every row in a real section, and asks for something", () => {
        resetDatabase();
        const rows = checklistFor(family.code, family);

        expect(rows.length).toBeGreaterThan(5);
        for (const row of rows) {
          expect(DOCUMENT_CATEGORIES as readonly string[]).toContain(row.category);
        }
      });

      it("asks every customer for their KYC", () => {
        resetDatabase();
        const labels = checklistFor(family.code, family).map((r) => r.label);

        expect(labels).toContain("PAN Card");
        expect(labels).toContain("Aadhaar Card");
        expect(labels).toContain("Address Proof");
        expect(labels).toContain("Passport Size Photograph");
      });
    });
  }

  it("names each year of a recurring document distinctly on a business loan", () => {
    resetDatabase();
    const labels = checklistFor("bl_working_capital", { employment: "business_owner" }).map(
      (r) => r.label,
    );

    // Three years of GST returns and three of the business ITR — six rows
    // that used to render as three identical-looking pairs.
    const gst = labels.filter((l) => l.startsWith("GST 3B"));
    const itr = labels.filter((l) => l.startsWith("Business ITR"));

    expect(gst).toHaveLength(3);
    expect(itr).toHaveLength(3);
    expect(new Set(gst).size).toBe(3);
    expect(new Set(itr).size).toBe(3);
    for (const label of gst) expect(label).toMatch(/ – FY \d{4}-\d{2}$/);
    // The returns are named by ASSESSMENT year — the number on the document
    // the customer is holding.
    for (const label of itr) expect(label).toMatch(/ – AY \d{4}-\d{2}$/);
  });

  it("asks a business loan for Amaze's standard business set on the day it is created", () => {
    resetDatabase();
    const labels = checklistFor("bl_working_capital").map((r) => r.label);

    for (const expected of [
      "Business Registration Proof",
      "GST Registration Certificate (GST REG-06)",
      "Business PAN Card",
      "Business Address Proof",
      "Udyam Registration Certificate",
      "Balance Sheet – FY " + financialYearOf(new Date()).label,
    ]) {
      expect(labels, `business loan should ask for ${expected}`).toContain(expected);
    }
  });

  it("asks for no property documents until a property exists", () => {
    resetDatabase();
    const withoutProperty = checklistFor("lap_commercial", { employment: "business_owner" }).map(
      (r) => r.category,
    );
    expect(withoutProperty).not.toContain("property");

    const withProperty = checklistFor("lap_commercial", {
      property: true,
      employment: "business_owner",
    }).map((r) => r.label);
    expect(withProperty).toContain("Patta & Chitta");
    expect(withProperty).toContain("Encumbrance Certificate (EC)");
    expect(withProperty).toContain("Parent Documents");
  });
});
