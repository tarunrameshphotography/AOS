import { describe, expect, it } from "vitest";

import type { Database, LoanCase, Submission } from "./fake/types.js";
import { waitingOn } from "./lib.js";

/** A minimal, otherwise-empty database — just enough for waitingOn's lookups. */
function baseDb(): Database {
  return {
    people: [],
    organisations: [],
    employments: [],
    properties: [],
    users: [],
    loanProducts: [],
    documentTypes: [],
    rejectionReasons: [],
    customerProducts: [],
    employmentTypes: [],
    businessConstitutions: [],
    propertyTypes: [],
    propertyOwnershipTypes: [],
    referralSources: [],
    districts: [],
    cities: [],
    borrowerTypes: [],
    securityTypes: [],
    requirementApplicabilities: [],
    lenderTypes: [],
    lenderRelationshipRoles: [],
    submissionModes: [],
    lenderInsightCategories: [],
    lenderProfiles: [],
    bankBranches: [],
    bankContacts: [],
    bankProducts: [],
    lenderSubmissionRules: [],
    lenderInsights: [],
    cases: [],
    caseParties: [],
    caseProperties: [],
    documents: [],
    requirements: [],
    documentRequirementRules: [],
    submissions: [],
    submissionRecipients: [],
    offers: [],
    communications: [],
    notes: [],
    tasks: [],
    events: [],
    caseNumberSequence: {},
  };
}

function baseCase(overrides: Partial<LoanCase> = {}): LoanCase {
  return {
    id: "cas_1",
    caseNumber: "AL-2026-00001",
    loanProductId: "lpr_1",
    stage: "documents_pending",
    ownerUserId: "usr_1",
    isOnHold: false,
    isInvoiceRaised: false,
    tags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const zeroProgress = { rejectedCount: 0, receivedCount: 0, outstandingCount: 0 };

describe("waitingOn — who acts next, distinct from who currently holds the case", () => {
  it("returns null for terminal stages — nothing is meaningfully waiting on a closed or lost case", () => {
    const db = baseDb();
    expect(waitingOn(db, baseCase({ stage: "closed" }), zeroProgress, [])).toBeNull();
    expect(waitingOn(db, baseCase({ stage: "lost" }), zeroProgress, [])).toBeNull();
  });

  it("attributes early stages to the Telecaller role when the owner does not hold that role", () => {
    const db = baseDb();
    db.users = [{ id: "usr_1", personId: "per_1", name: "Priya Raman", username: "priya.raman", passwordHash: "x", roles: ["manager"], isActive: true }];
    const result = waitingOn(db, baseCase({ stage: "new" }), zeroProgress, []);
    expect(result?.summary).toBe("Waiting on: Telecaller — make contact and move this case forward");
  });

  it("names the owner by name when they actually hold the Telecaller role", () => {
    const db = baseDb();
    db.users = [{ id: "usr_1", personId: "per_1", name: "Priya Raman", username: "priya.raman", passwordHash: "x", roles: ["telecaller"], isActive: true }];
    const result = waitingOn(db, baseCase({ stage: "contacted" }), zeroProgress, []);
    expect(result?.summary).toContain("Priya Raman");
  });

  it("changes to Login Desk once a document is uploaded and awaiting verification", () => {
    const db = baseDb();
    db.users = [{ id: "usr_1", personId: "per_1", name: "Priya Raman", username: "priya.raman", passwordHash: "x", roles: ["telecaller"], isActive: true }];
    const result = waitingOn(
      db,
      baseCase({ stage: "documents_pending" }),
      { rejectedCount: 0, receivedCount: 3, outstandingCount: 3 },
      [],
    );
    expect(result?.summary).toBe("Waiting on: Login Desk — 3 documents awaiting verification");
  });

  it("changes to Telecaller when a document is rejected and needs re-collection", () => {
    const db = baseDb();
    const result = waitingOn(
      db,
      baseCase({ stage: "documents_pending" }),
      { rejectedCount: 1, receivedCount: 2, outstandingCount: 3 },
      [],
    );
    // Rejection takes priority — a document already awaiting verification is
    // not the blocker if another one was just kicked back to the customer.
    expect(result?.summary).toContain("Telecaller");
    expect(result?.summary).toContain("1 document rejected");
  });

  it("names the owner by name when they actually hold the Login Executive role", () => {
    const db = baseDb();
    db.users = [
      { id: "usr_2", personId: "per_2", name: "Karthik V", username: "karthik.v", passwordHash: "x", roles: ["login_executive"], isActive: true },
    ];
    const result = waitingOn(
      db,
      baseCase({ stage: "documents_pending", ownerUserId: "usr_2" }),
      { rejectedCount: 0, receivedCount: 1, outstandingCount: 1 },
      [],
    );
    expect(result?.summary).toContain("Karthik V");
  });

  it("returns null once nothing is outstanding and the stage has not yet caught up", () => {
    const db = baseDb();
    const result = waitingOn(db, baseCase({ stage: "documents_pending" }), zeroProgress, []);
    expect(result).toBeNull();
  });

  it("points to Login Desk to submit once ready and no bank has been added yet", () => {
    const db = baseDb();
    const result = waitingOn(db, baseCase({ stage: "ready_for_submission" }), zeroProgress, []);
    expect(result?.summary).toContain("Login Desk");
    expect(result?.summary).toContain("send this file to a bank");
  });

  it("flags a bank's query as Login Desk's turn", () => {
    const db = baseDb();
    const submissions: Pick<Submission, "status">[] = [{ status: "query_raised" }];
    const result = waitingOn(db, baseCase({ stage: "submitted" }), zeroProgress, submissions);
    expect(result?.summary).toContain("Login Desk");
    expect(result?.summary).toContain("query");
  });

  it("names the bank, not a colleague, once a decision is genuinely out of AOS's hands", () => {
    const db = baseDb();
    const submissions: Pick<Submission, "status">[] = [{ status: "under_process" }];
    const result = waitingOn(db, baseCase({ stage: "submitted" }), zeroProgress, submissions);
    expect(result?.summary).toBe("Waiting on: the bank — a decision is pending");
  });
});
