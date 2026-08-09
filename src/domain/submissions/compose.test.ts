import { describe, expect, it } from "vitest";

import type { CandidateDocument } from "./attachments.js";
import { groupsIn, planBatches, type AttachmentBatch } from "./batching.js";
import {
  composeBody,
  composeGreeting,
  composeSubject,
  describeContents,
  describeSubmissionForTimeline,
  type SubmissionContext,
} from "./compose.js";

const MB = 1024 * 1024;

let seq = 0;
function doc(
  documentTypeCode: string,
  label: string,
  megabytes: number,
  overrides: Partial<CandidateDocument> = {},
): CandidateDocument {
  seq += 1;
  return {
    documentId: `doc_${seq}`,
    documentTypeCode,
    label,
    fileName: `${documentTypeCode}-${seq}.pdf`,
    fileSizeBytes: Math.round(megabytes * MB),
    category: "additional",
    version: 1,
    verifiedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

const CONTEXT: SubmissionContext = {
  customerName: "Ravi Kumar",
  loanTypeName: "Machinery and Equipment Loan",
  counterparty: "HDFC Bank — RS Puram",
  caseNumber: "AL-2026-00051",
};

const SENDER = { name: "Amaze Loans", address: "amazeloans@gmail.com" };

function batch(documents: readonly CandidateDocument[], sequence = 1): AttachmentBatch {
  return {
    sequence,
    documents,
    totalBytes: documents.reduce((total, document) => total + document.fileSizeBytes, 0),
    groups: groupsIn(documents),
  };
}

describe("subject", () => {
  const gst = doc("gst_certificate", "GST Registration Certificate (GST REG-06)", 1.2);
  const itr = doc("itr", "ITR – AY 2026-27", 2.4, { financialYearLabel: "2025-26" });

  it("is CUSTOMER NAME - LOAN TYPE - DOCUMENT DESCRIPTION", () => {
    expect(composeSubject(CONTEXT, batch([gst, itr]), 1)).toBe(
      "Ravi Kumar - Machinery and Equipment Loan - GST & ITR Documents",
    );
  });

  it("uses the customer-facing loan name AOS already holds, not a new one", () => {
    // ADR-033's name, verbatim. This test exists so nobody "tidies" the
    // subject into a shorter invented product vocabulary.
    expect(composeSubject(CONTEXT, batch([gst]), 1)).toContain("Machinery and Equipment Loan");
  });

  it("numbers itself when the submission runs to more than one email", () => {
    expect(composeSubject(CONTEXT, batch([gst], 1), 3)).toBe(
      "Ravi Kumar - Machinery and Equipment Loan - GST Documents (1/3)",
    );
    expect(composeSubject(CONTEXT, batch([itr], 2), 3)).toBe(
      "Ravi Kumar - Machinery and Equipment Loan - ITR Documents (2/3)",
    );
  });

  it("says nothing about sequence when there is only one email", () => {
    expect(composeSubject(CONTEXT, batch([gst]), 1)).not.toContain("(1/1)");
  });

  it("describes what is actually in THIS email rather than a generic word", () => {
    // Two emails from one submission must be tellable apart in an inbox
    // without opening either.
    const planned = planBatches([
      doc("gst_returns", "GST 3B – FY 2025-26", 5, { financialYearLabel: "2025-26" }),
      doc("gst_returns", "GST 3B – FY 2024-25", 4.5, { financialYearLabel: "2024-25" }),
      doc("itr", "ITR – AY 2026-27", 5, { financialYearLabel: "2025-26" }),
      doc("itr", "ITR – AY 2025-26", 4.5, { financialYearLabel: "2024-25" }),
    ]);
    if (!planned.ok) throw new Error("expected a plan");

    const subjects = planned.batches.map((b) =>
      composeSubject(CONTEXT, b, planned.batches.length),
    );
    expect(subjects).toEqual([
      "Ravi Kumar - Machinery and Equipment Loan - GST Documents (1/2)",
      "Ravi Kumar - Machinery and Equipment Loan - ITR Documents (2/2)",
    ]);
    expect(new Set(subjects).size).toBe(subjects.length);
  });
});

describe("greeting", () => {
  it("uses the banker's given name when it is known", () => {
    expect(composeGreeting({ email: "karthik@examplebank.com", name: "Karthik" })).toBe(
      "Dear Karthik,",
    );
    expect(composeGreeting({ email: "k@bank.com", name: "Karthik V" })).toBe("Dear Karthik,");
    expect(composeGreeting({ email: "k@bank.com", name: "S. Karthik" })).toBe("Dear Karthik,");
  });

  it("falls back to a professional generic greeting rather than guessing", () => {
    // Half the addresses a file goes to are desks. Deriving "Homeloans" from
    // homeloans.cbe@bank.com would be worse than saying nothing.
    expect(composeGreeting({ email: "homeloans.cbe@examplebank.com" })).toBe("Dear Sir / Madam,");
    expect(composeGreeting({ email: "desk@bank.com", name: "   " })).toBe("Dear Sir / Madam,");
  });

  it("does not truncate a name that is only initials", () => {
    expect(composeGreeting({ email: "k@bank.com", name: "V K" })).toBe("Dear V K,");
  });
});

describe("contents", () => {
  it("counts years where a group spans more than one", () => {
    const documents = [
      doc("gst_certificate", "GST Registration Certificate", 1),
      doc("itr", "ITR – AY 2026-27", 1, { financialYearLabel: "2025-26" }),
      doc("itr", "ITR – AY 2025-26", 1, { financialYearLabel: "2024-25" }),
      doc("itr", "ITR – AY 2024-25", 1, { financialYearLabel: "2023-24" }),
    ];
    expect(describeContents(documents)).toBe(
      "the GST documents and three years of ITR documents",
    );
  });

  it("does not count when a group has one year or none", () => {
    expect(describeContents([doc("bank_statement", "Bank Statement", 1)])).toBe(
      "the bank statements",
    );
  });
});

describe("body", () => {
  const documents = [
    doc("gst_certificate", "GST Registration Certificate (GST REG-06)", 1.2),
    doc("itr", "ITR – AY 2026-27", 2.4, { financialYearLabel: "2025-26" }),
    doc("itr", "ITR – AY 2025-26", 2.3, { financialYearLabel: "2024-25" }),
    doc("itr", "ITR – AY 2024-25", 2.0, { financialYearLabel: "2023-24" }),
  ];

  const body = composeBody({
    context: CONTEXT,
    recipient: { email: "karthik@examplebank.com", name: "Karthik" },
    batch: batch(documents),
    batchCount: 1,
    sender: SENDER,
  });

  it("reads like an employee wrote it, not like a notification", () => {
    expect(body).toContain("Dear Karthik,");
    expect(body).toContain(
      "Please find attached the GST documents and three years of ITR documents for Ravi Kumar's Machinery and Equipment Loan application.",
    );
    expect(body).toContain(
      "Please review the attached documents and let us know if anything further is required from our end.",
    );
    expect(body).toContain("Regards,\nAmaze Loans\namazeloans@gmail.com");
  });

  it("does not invent an honorific for the customer", () => {
    // AOS holds no gender for anybody. "Mr." derived from a name is a guess,
    // and a letter to a bank is a bad place to guess.
    expect(body).not.toMatch(/\bMr\.|\bMrs\.|\bMs\./);
  });

  it("lists every attachment by the name the checklist uses, year included", () => {
    for (const document of documents) {
      expect(body).toContain(document.label);
    }
    expect(body).toContain("Attached (4):");
  });

  it("says nothing about sequence for a single email", () => {
    expect(body).not.toContain("This is email");
  });

  it("explains the split, and says outright that nothing is missing", () => {
    const split = composeBody({
      context: CONTEXT,
      recipient: { email: "karthik@examplebank.com", name: "Karthik" },
      batch: batch(documents, 2),
      batchCount: 3,
      sender: SENDER,
    });
    expect(split).toContain("This is email 2 of 3.");
    expect(split).toContain("nothing is missing");
  });

  it("is deterministic — the same inputs give byte-identical output", () => {
    const again = composeBody({
      context: CONTEXT,
      recipient: { email: "karthik@examplebank.com", name: "Karthik" },
      batch: batch(documents),
      batchCount: 1,
      sender: SENDER,
    });
    expect(again).toBe(body);
  });
});

describe("timeline summary", () => {
  it("says what happened, not which mechanism carried it", () => {
    const summary = describeSubmissionForTimeline({
      documentCount: 8,
      batchCount: 3,
      recipients: ["karthik@examplebank.com"],
      counterparty: "HDFC Bank — RS Puram",
    });
    expect(summary).toContain("Documents sent to banker");
    expect(summary).toContain("HDFC Bank — RS Puram");
    expect(summary).toContain("8 verified documents");
    expect(summary).toContain("3 emails");
    expect(summary).not.toBe("Email sent");
  });
});
