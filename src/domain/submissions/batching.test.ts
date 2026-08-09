import { describe, expect, it } from "vitest";

import { MAX_ATTACHMENT_BYTES_PER_EMAIL, type CandidateDocument } from "./attachments.js";
import { describeGroups, groupOf, planBatches } from "./batching.js";

const MB = 1024 * 1024;

let seq = 0;
function doc(
  documentTypeCode: string,
  megabytes: number,
  overrides: Partial<CandidateDocument> = {},
): CandidateDocument {
  seq += 1;
  return {
    documentId: `doc_${seq}`,
    documentTypeCode,
    label: `${documentTypeCode} ${seq}`,
    fileName: `${documentTypeCode}-${seq}.pdf`,
    fileSizeBytes: Math.round(megabytes * MB),
    category: "additional",
    version: 1,
    verifiedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function batchesOf(documents: readonly CandidateDocument[]) {
  const result = planBatches(documents);
  if (!result.ok) throw new Error(`expected a plan, got ${result.problem.kind}`);
  return result.batches;
}

// The milestone's own worked example, to the byte.
const WORKED_EXAMPLE: readonly CandidateDocument[] = [
  doc("gst_certificate", 1.2),
  doc("gst_returns", 1.8, { financialYearLabel: "2025-26" }),
  doc("gst_returns", 1.7, { financialYearLabel: "2024-25" }),
  doc("itr", 2.4, { financialYearLabel: "2025-26" }),
  doc("itr", 2.3, { financialYearLabel: "2024-25" }),
  doc("itr", 2.0, { financialYearLabel: "2023-24" }),
  doc("bank_statement", 4.8),
];

describe("grouping — how a banker reads a file", () => {
  it("puts the GST certificate with the GST returns, not with the business papers", () => {
    // The certificate is COLLECTED with the business's papers and READ with
    // the returns. Splitting them means a credit manager queries a
    // certificate that was already sent.
    expect(groupOf(doc("gst_certificate", 1))).toBe("gst");
    expect(groupOf(doc("gst_returns", 1))).toBe("gst");
  });

  it("reads the personal and business returns as one run", () => {
    expect(groupOf(doc("itr", 1))).toBe("itr");
    expect(groupOf(doc("org_itr", 1))).toBe("itr");
    expect(groupOf(doc("form_16", 1))).toBe("itr");
    expect(groupOf(doc("form_26as", 1))).toBe("itr");
  });

  it("falls back to the checklist's own section for anything not named", () => {
    expect(groupOf(doc("pan_card", 1, { category: "kyc" }))).toBe("kyc");
    expect(groupOf(doc("sale_deed", 1, { category: "property" }))).toBe("property");
    // A document type added to the catalogue tomorrow lands somewhere sensible
    // without anybody remembering to edit the map.
    expect(groupOf(doc("some_new_type", 1, { category: "income" }))).toBe("income");
    expect(groupOf(doc("some_new_type", 1, { category: "who_knows" }))).toBe("additional");
  });
});

describe("splitting", () => {
  it("produces one email when everything fits", () => {
    const batches = batchesOf([doc("pan_card", 0.2, { category: "kyc" }), doc("itr", 1.1)]);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.sequence).toBe(1);
  });

  it("produces several when the selection exceeds the limit", () => {
    // 16.2 MB in total — cannot be one email under any grouping.
    const batches = batchesOf(WORKED_EXAMPLE);
    expect(batches.length).toBeGreaterThan(1);
  });

  it("never lets an individual email exceed 10 MB", () => {
    for (const batch of batchesOf(WORKED_EXAMPLE)) {
      expect(batch.totalBytes).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES_PER_EMAIL);
    }
  });

  it("sends every selected document, exactly once", () => {
    const batches = batchesOf(WORKED_EXAMPLE);
    const sent = batches.flatMap((batch) => batch.documents.map((document) => document.documentId));
    expect(sent).toHaveLength(WORKED_EXAMPLE.length);
    expect(new Set(sent).size).toBe(WORKED_EXAMPLE.length);
    expect([...sent].sort()).toEqual([...WORKED_EXAMPLE.map((d) => d.documentId)].sort());
  });

  it("keeps a reading group together when it fits in one email", () => {
    const batches = batchesOf(WORKED_EXAMPLE);
    const gstBatches = new Set(
      batches
        .filter((batch) => batch.documents.some((document) => groupOf(document) === "gst"))
        .map((batch) => batch.sequence),
    );
    const itrBatches = new Set(
      batches
        .filter((batch) => batch.documents.some((document) => groupOf(document) === "itr"))
        .map((batch) => batch.sequence),
    );
    expect(gstBatches.size).toBe(1);
    expect(itrBatches.size).toBe(1);
  });

  it("splits a group that is too large for one email rather than exceeding the limit", () => {
    // Size safety takes precedence over keeping a group whole — stated
    // outright in the milestone, and this is the case that exercises it.
    const batches = batchesOf([
      doc("itr", 4, { financialYearLabel: "2025-26" }),
      doc("itr", 4, { financialYearLabel: "2024-25" }),
      doc("itr", 4, { financialYearLabel: "2023-24" }),
    ]);
    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      expect(batch.totalBytes).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES_PER_EMAIL);
    }
  });

  it("orders financial years most recent first, and keeps each label on its own document", () => {
    const batches = batchesOf(WORKED_EXAMPLE);
    const itrs = batches
      .flatMap((batch) => batch.documents)
      .filter((document) => document.documentTypeCode === "itr");

    expect(itrs.map((document) => document.financialYearLabel)).toEqual([
      "2025-26",
      "2024-25",
      "2023-24",
    ]);
    // And the label is still attached to the file it belongs to, not merely
    // in the right order — the failure mode is a year drifting one row.
    expect(
      itrs.map((document) => `${document.financialYearLabel}:${document.fileSizeBytes}`),
    ).toEqual([
      `2025-26:${Math.round(2.4 * MB)}`,
      `2024-25:${Math.round(2.3 * MB)}`,
      `2023-24:${Math.round(2 * MB)}`,
    ]);
  });

  it("is deterministic — the same selection in any input order plans identically", () => {
    const forwards = batchesOf(WORKED_EXAMPLE);
    const backwards = batchesOf([...WORKED_EXAMPLE].reverse());
    const shuffled = batchesOf([
      WORKED_EXAMPLE[3]!,
      WORKED_EXAMPLE[0]!,
      WORKED_EXAMPLE[6]!,
      WORKED_EXAMPLE[2]!,
      WORKED_EXAMPLE[5]!,
      WORKED_EXAMPLE[1]!,
      WORKED_EXAMPLE[4]!,
    ]);

    const shape = (batches: ReturnType<typeof batchesOf>) =>
      batches.map((batch) => batch.documents.map((document) => document.documentId));

    expect(shape(backwards)).toEqual(shape(forwards));
    expect(shape(shuffled)).toEqual(shape(forwards));
  });
});

describe("refusals", () => {
  it("refuses an empty selection rather than sending an empty email", () => {
    const result = planBatches([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("nothing_selected");
  });

  it("names the file when one document is larger than a whole email", () => {
    const oversized = doc("sale_deed", 14, { category: "property", label: "Sale Deed" });
    const result = planBatches([doc("pan_card", 0.3, { category: "kyc" }), oversized]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.kind).toBe("document_not_sendable");
      if (result.problem.kind === "document_not_sendable") {
        expect(result.problem.document.label).toBe("Sale Deed");
        expect(result.problem.reason.kind).toBe("too_large");
      }
    }
  });

  it("refuses the whole plan rather than dropping an unverified document from it", () => {
    // The dangerous alternative is filtering it out silently: the file goes
    // to the bank one document short and nobody knows.
    const result = planBatches([doc("pan_card", 0.3), doc("itr", 1, { verifiedAt: undefined })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem.kind).toBe("document_not_sendable");
  });
});

describe("the invariants hold over many generated selections", () => {
  /** A tiny deterministic PRNG — the same cases every run, on every machine. */
  function lcg(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
  }

  const TYPES = [
    ["pan_card", "kyc"],
    ["aadhaar_card", "kyc"],
    ["gst_certificate", "business_registration"],
    ["gst_returns", "business_financials"],
    ["itr", "income"],
    ["org_itr", "business_financials"],
    ["bank_statement", "income"],
    ["balance_sheet", "business_financials"],
    ["sale_deed", "property"],
    ["machinery_quotation", "additional"],
  ] as const;

  it("no batch over the limit, every document exactly once, over 300 random selections", () => {
    const random = lcg(20260809);

    for (let run = 0; run < 300; run += 1) {
      const count = 1 + Math.floor(random() * 14);
      const documents: CandidateDocument[] = [];
      for (let index = 0; index < count; index += 1) {
        const [code, category] = TYPES[Math.floor(random() * TYPES.length)]!;
        // Up to the ceiling but never over it: a single oversized file is a
        // refusal, and that case has its own test above.
        const size = Math.max(1024, Math.floor(random() * MAX_ATTACHMENT_BYTES_PER_EMAIL));
        documents.push({
          documentId: `r${run}_${index}`,
          documentTypeCode: code,
          label: `${code} ${index}`,
          fileName: `${code}-${index}.pdf`,
          fileSizeBytes: size,
          category,
          version: 1,
          verifiedAt: "2026-08-01T10:00:00.000Z",
        });
      }

      const result = planBatches(documents);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const sent = result.batches.flatMap((batch) =>
        batch.documents.map((document) => document.documentId),
      );
      expect(new Set(sent).size).toBe(documents.length);
      expect(sent).toHaveLength(documents.length);

      for (const batch of result.batches) {
        expect(batch.totalBytes).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES_PER_EMAIL);
        expect(batch.documents.length).toBeGreaterThan(0);
      }
      expect(result.batches.map((batch) => batch.sequence)).toEqual(
        result.batches.map((_, index) => index + 1),
      );
    }
  });
});

describe("describing what is in an email", () => {
  it("uses a group's own phrase when it is alone", () => {
    expect(describeGroups(["bank_statements"])).toBe("Bank Statements");
    expect(describeGroups(["gst"])).toBe("GST Documents");
  });

  it("collapses two or three into one noun phrase", () => {
    expect(describeGroups(["gst", "itr"])).toBe("GST & ITR Documents");
    expect(describeGroups(["kyc", "gst", "itr"])).toBe("KYC, GST & ITR Documents");
  });

  it("names the first two and says Other beyond that, rather than listing everything", () => {
    expect(describeGroups(["kyc", "gst", "itr", "property"])).toBe("KYC, GST & Other Documents");
  });
});
