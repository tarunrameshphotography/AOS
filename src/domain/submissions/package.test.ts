import { describe, expect, it } from "vitest";

import { MAX_ATTACHMENT_BYTES_PER_EMAIL, type CandidateDocument } from "./attachments.js";
import type { SubmissionContext } from "./compose.js";
import {
  describePackageProblem,
  documentIdsIn,
  planSubmissionPackage,
  type PackagePlanInput,
} from "./package.js";

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

/** The milestone's worked example. 16.2 MB, so it cannot be one email. */
function workedExample(): CandidateDocument[] {
  return [
    doc("gst_certificate", "GST Registration Certificate (GST REG-06)", 1.2),
    doc("gst_returns", "GST 3B – FY 2025-26", 1.8, { financialYearLabel: "2025-26" }),
    doc("gst_returns", "GST 3B – FY 2024-25", 1.7, { financialYearLabel: "2024-25" }),
    doc("itr", "ITR – AY 2026-27", 2.4, { financialYearLabel: "2025-26" }),
    doc("itr", "ITR – AY 2025-26", 2.3, { financialYearLabel: "2024-25" }),
    doc("itr", "ITR – AY 2024-25", 2.0, { financialYearLabel: "2023-24" }),
    doc("bank_statement", "Bank Statement", 4.8),
  ];
}

function input(overrides: Partial<PackagePlanInput> = {}): PackagePlanInput {
  return {
    context: CONTEXT,
    recipients: [{ email: "karthik@examplebank.com", name: "Karthik", kind: "to" }],
    documents: workedExample(),
    sender: SENDER,
    ...overrides,
  };
}

function planOf(overrides: Partial<PackagePlanInput> = {}) {
  const result = planSubmissionPackage(input(overrides));
  if (!result.ok) throw new Error(`expected a plan, got ${result.problem.kind}`);
  return result.plan;
}

describe("the package a user reviews", () => {
  it("carries the case's own facts — customer, product, bank", () => {
    const plan = planOf();
    expect(plan.context.customerName).toBe("Ravi Kumar");
    expect(plan.context.loanTypeName).toBe("Machinery and Equipment Loan");
    expect(plan.context.counterparty).toBe("HDFC Bank — RS Puram");
  });

  it("addresses the banker who was chosen, and keeps their name", () => {
    const plan = planOf();
    expect(plan.to).toEqual([{ email: "karthik@examplebank.com", name: "Karthik" }]);
    expect(plan.emails[0]?.body).toContain("Dear Karthik,");
  });

  it("separates To from Copied", () => {
    const plan = planOf({
      recipients: [
        { email: "karthik@examplebank.com", name: "Karthik", kind: "to" },
        { email: "homeloans.cbe@examplebank.com", kind: "cc" },
      ],
    });
    expect(plan.to.map((r) => r.email)).toEqual(["karthik@examplebank.com"]);
    expect(plan.cc.map((r) => r.email)).toEqual(["homeloans.cbe@examplebank.com"]);
  });

  it("greets the PRIMARY addressee rather than whoever sorts first", () => {
    const plan = planOf({
      recipients: [
        { email: "credit@examplebank.com", name: "Anitha", kind: "to" },
        { email: "karthik@examplebank.com", name: "Karthik", kind: "to", isPrimary: true },
      ],
    });
    expect(plan.emails[0]?.body).toContain("Dear Karthik,");
  });

  it("splits the worked example rather than exceeding the limit", () => {
    const plan = planOf();
    expect(plan.emails.length).toBeGreaterThan(1);
    for (const email of plan.emails) {
      expect(email.totalBytes).toBeLessThanOrEqual(MAX_ATTACHMENT_BYTES_PER_EMAIL);
    }
  });

  it("sends every selected document exactly once", () => {
    const documents = workedExample();
    const plan = planOf({ documents });
    const ids = documentIdsIn(plan);
    expect(ids).toHaveLength(documents.length);
    expect(new Set(ids).size).toBe(documents.length);
    expect([...ids].sort()).toEqual(documents.map((d) => d.documentId).sort());
    expect(plan.documentCount).toBe(documents.length);
  });

  it("numbers every email in its subject when there is more than one", () => {
    const plan = planOf();
    plan.emails.forEach((email, index) => {
      expect(email.subject).toContain(`(${index + 1}/${plan.emails.length})`);
      expect(email.sequence).toBe(index + 1);
    });
  });

  it("keeps each financial-year label on the document it belongs to", () => {
    const plan = planOf();
    const byId = new Map(workedExample().map((d) => [`${d.label}`, d.financialYearLabel]));
    for (const email of plan.emails) {
      for (const document of email.documents) {
        expect(document.financialYearLabel).toBe(byId.get(document.label));
      }
    }
    // And the years actually reach the body a banker reads.
    const allBodies = plan.emails.map((email) => email.body).join("\n");
    expect(allBodies).toContain("ITR – AY 2026-27");
    expect(allBodies).toContain("GST 3B – FY 2024-25");
  });

  it("fits in one email when the selection is small", () => {
    const plan = planOf({
      documents: [doc("pan_card", "PAN Card", 0.2, { category: "kyc" })],
    });
    expect(plan.emails).toHaveLength(1);
    expect(plan.emails[0]?.subject).not.toContain("(1/1)");
  });
});

describe("refusals, in the order a user can act on them", () => {
  it("refuses an address that is not shaped like one", () => {
    const result = planSubmissionPackage(input({ recipients: [{ email: "karthik", kind: "to" }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.kind).toBe("recipients");
      expect(describePackageProblem(result.problem)).toContain("does not look like an email address");
    }
  });

  it("refuses when nobody is given at all", () => {
    const result = planSubmissionPackage(input({ recipients: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(describePackageProblem(result.problem)).toContain("at least one");
  });

  it("refuses when everybody is copied and nobody is addressed", () => {
    const result = planSubmissionPackage(
      input({ recipients: [{ email: "desk@examplebank.com", kind: "cc" }] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.kind).toBe("no_addressee");
      expect(describePackageProblem(result.problem)).toContain("nobody is addressed");
    }
  });

  it("refuses the same address twice", () => {
    const result = planSubmissionPackage(
      input({
        recipients: [
          { email: "karthik@examplebank.com", kind: "to" },
          { email: "KARTHIK@examplebank.com", kind: "cc" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(describePackageProblem(result.problem)).toContain("listed twice");
  });

  it("names the oversized file, and says what to do about it", () => {
    const result = planSubmissionPackage(
      input({
        documents: [
          doc("pan_card", "PAN Card", 0.2, { category: "kyc" }),
          doc("sale_deed", "Sale Deed", 13, { category: "property" }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const sentence = describePackageProblem(result.problem);
      expect(sentence).toContain("Sale Deed");
      expect(sentence).toMatch(/smaller scan|split/i);
    }
  });

  it("refuses an unverified document instead of quietly leaving it out", () => {
    const result = planSubmissionPackage(
      input({
        documents: [
          doc("pan_card", "PAN Card", 0.2, { category: "kyc" }),
          doc("itr", "ITR – AY 2026-27", 1, { verifiedAt: undefined }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(describePackageProblem(result.problem)).toContain("Not verified");
  });

  it("refuses a rejected document", () => {
    const result = planSubmissionPackage(
      input({
        documents: [
          doc("itr", "ITR – AY 2026-27", 1, { rejectedAt: "2026-08-02T00:00:00.000Z" }),
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(describePackageProblem(result.problem)).toContain("Rejected on review");
  });

  it("refuses an empty selection", () => {
    const result = planSubmissionPackage(input({ documents: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(describePackageProblem(result.problem)).toContain("at least one verified document");
  });

  it("would refuse a batch a provider could not carry, before anything is sent", () => {
    // Unreachable with Gmail's real limit — proven in attachments.test.ts —
    // so the check is exercised against a deliberately tiny provider.
    const result = planSubmissionPackage(
      input({
        documents: [doc("pan_card", "PAN Card", 1, { category: "kyc" })],
        providerMaxMessageBytes: 100,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.kind).toBe("over_provider_limit");
      expect(describePackageProblem(result.problem)).toContain("too large for the mail provider");
    }
  });
});

describe("determinism", () => {
  it("plans identically twice, so the review screen and the sender cannot disagree", () => {
    const documents = workedExample();
    const first = planOf({ documents });
    const second = planOf({ documents });

    expect(second.emails.map((email) => email.subject)).toEqual(
      first.emails.map((email) => email.subject),
    );
    expect(second.emails.map((email) => email.body)).toEqual(
      first.emails.map((email) => email.body),
    );
    expect(documentIdsIn(second)).toEqual(documentIdsIn(first));
  });
});
