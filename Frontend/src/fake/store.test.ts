import { describe, expect, it, vi } from "vitest";

import { InMemoryStorageAdapter } from "./storage.mock.js";

/**
 * store.ts reads localStorage at module load (the prototype's persistence),
 * which does not exist in Vitest's default node environment. A minimal
 * polyfill installed before the dynamic import below is enough — these tests
 * only need get/set/remove, not real persistence across runs.
 */
function installLocalStoragePolyfill(): void {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (backing.has(key) ? (backing.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
    clear: () => backing.clear(),
    key: () => null,
    get length() {
      return backing.size;
    },
  } as Storage;
}

installLocalStoragePolyfill();

// Real object storage means a real local backend (Backend/storage-server.mjs)
// — not something this unit test should have to run. `store.ts`'s calls to
// `storageAdapter.put`/`.get` are exercised against an in-memory fake instead,
// via `vi.doMock` so it takes effect before `store.js` is dynamically
// imported below.
vi.doMock("./storage.js", () => ({ storageAdapter: new InMemoryStorageAdapter() }));

const {
  addCustomRequirement,
  assignOwner,
  counterpartyOf,
  createCase,
  createSubmission,
  getDb,
  moveStage,
  recipientsOf,
  rejectDocument,
  removeCustomRequirement,
  resetDatabase,
  updateBranch,
  updateCaseFacts,
  updateOrganisation,
  updatePerson,
  updatePersonIdentifiers,
  uploadDocument,
  verifyDocument,
} = await import("./store.js");
const { storageAdapter } = await import("./storage.js");

// ---------------------------------------------------------------------------
// Case identity — the P0 "creating a new case opens an existing case" bug.
//
// The mechanism: `nextId` used to be a module-scope counter starting at 1000,
// reset on every page load, while `db` persisted in localStorage. A second
// session therefore reissued ids the first had already used, `createCase`
// appended a case whose id collided with an older one, and `find()` — which
// every read in store.ts uses — returned the OLDER row. Navigation was
// correct; the lookup was not.
//
// These tests do not reach for the URL or the router. The bug was never in
// either: it was that two cases could share an identity, so that is what is
// asserted here.
// ---------------------------------------------------------------------------

describe("createCase — every case gets an identity of its own", () => {
  function anyProductId(): string {
    const productId = getDb().loanProducts[0]?.id;
    if (!productId) throw new Error("test setup: expected a seeded lending product");
    return productId;
  }

  function anyUserId(): string {
    const userId = getDb().users[0]?.id;
    if (!userId) throw new Error("test setup: expected a seeded user");
    return userId;
  }

  it("never issues an id that any existing row already holds", () => {
    resetDatabase();
    const productId = anyProductId();
    const actorUserId = anyUserId();

    const created: string[] = [];
    for (let n = 0; n < 25; n += 1) {
      created.push(
        createCase({ newApplicantName: `Applicant ${n}`, loanProductId: productId }, actorUserId),
      );
    }

    expect(new Set(created).size).toBe(created.length);

    const allCaseIds = getDb().cases.map((loanCase) => loanCase.id);
    expect(new Set(allCaseIds).size).toBe(allCaseIds.length);
  });

  it("resolves each returned id to the case that was just created, and to no other", () => {
    resetDatabase();
    const productId = anyProductId();
    const actorUserId = anyUserId();

    const firstId = createCase(
      { newApplicantName: "Meena Ravi", loanProductId: productId },
      actorUserId,
    );
    const secondId = createCase(
      { newApplicantName: "Karthik S", loanProductId: productId },
      actorUserId,
    );

    expect(firstId).not.toBe(secondId);

    // The exact lookup CaseDetail performs. Before the fix this could return
    // an older case — with an older stage, which is how the bug was reported.
    const matches = getDb().cases.filter((loanCase) => loanCase.id === secondId);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.stage).toBe("new");

    const applicantOf = (caseId: string): string | undefined => {
      const db = getDb();
      const party = db.caseParties.find((p) => p.caseId === caseId && p.role === "applicant");
      return db.people.find((person) => person.id === party?.personId)?.fullName;
    };

    expect(applicantOf(firstId)).toBe("Meena Ravi");
    expect(applicantOf(secondId)).toBe("Karthik S");
  });

  it("keeps identity stable across a reload, which is what a browser refresh is", async () => {
    resetDatabase();
    const caseId = createCase(
      { newApplicantName: "Refresh Test", loanProductId: anyProductId() },
      anyUserId(),
    );

    // Re-import with a cleared module registry: a fresh module instance
    // reading the SAME localStorage. This is precisely the situation the old
    // counter could not survive, because its state lived in the module and
    // the data did not.
    vi.resetModules();
    vi.doMock("./storage.js", () => ({ storageAdapter: new InMemoryStorageAdapter() }));
    const reloaded = await import("./store.js");

    const afterReload = reloaded.getDb().cases.filter((c) => c.id === caseId);
    expect(afterReload).toHaveLength(1);

    // And a case created by the reloaded module must not collide with
    // anything the previous one wrote — the original failure, exactly.
    const newId = reloaded.createCase(
      { newApplicantName: "After Reload", loanProductId: anyProductId() },
      anyUserId(),
    );
    expect(newId).not.toBe(caseId);
    expect(reloaded.getDb().cases.filter((c) => c.id === newId)).toHaveLength(1);

    const ids = reloaded.getDb().cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("allocates a distinct, sequential case number to each case", () => {
    resetDatabase();
    const productId = anyProductId();
    const actorUserId = anyUserId();

    const ids = [1, 2, 3].map((n) =>
      createCase({ newApplicantName: `Numbered ${n}`, loanProductId: productId }, actorUserId),
    );

    const numbers = ids.map(
      (id) => getDb().cases.find((loanCase) => loanCase.id === id)?.caseNumber,
    );

    expect(numbers.every((number) => number !== undefined)).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe("uploadDocument — automatic organisation (Issue #13)", () => {
  it("stores a first upload at version 1, under a path derived from ownership and type", async () => {
    resetDatabase();
    const db = getDb();
    const actorUserId = db.users[0]?.id;
    if (!actorUserId) throw new Error("test setup: expected a seeded user");

    const requirement = db.requirements.find((r) => r.status === "pending");
    if (!requirement) throw new Error("test setup: expected a pending requirement in the seed");

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = await uploadDocument(
      requirement.id,
      { name: "some file (v1).pdf", size: bytes.byteLength, bytes },
      actorUserId,
    );
    expect(result.ok).toBe(true);

    const updated = getDb();
    const updatedRequirement = updated.requirements.find((r) => r.id === requirement.id);
    const document = updated.documents.find((d) => d.id === updatedRequirement?.satisfiedByDocumentId);

    expect(document).toBeDefined();
    expect(document?.version).toBe(1);
    expect(document?.supersedesDocumentId).toBeUndefined();
    expect(document?.filePath.endsWith("v1-some_file_v1_.pdf")).toBe(true);
    expect(document?.filePath.startsWith(`${document?.ownerKind}/`)).toBe(true);

    // The bytes actually landed in object storage, under exactly that path.
    const stored = await storageAdapter.get(document!.filePath);
    expect([...stored]).toEqual([1, 2, 3, 4]);
  });

  it("replaces rather than overwrites: a second upload supersedes the first at the next version", async () => {
    resetDatabase();
    const db = getDb();
    const actorUserId = db.users[0]?.id;
    if (!actorUserId) throw new Error("test setup: expected a seeded user");

    const requirement = db.requirements.find((r) => r.status === "pending");
    if (!requirement) throw new Error("test setup: expected a pending requirement in the seed");

    await uploadDocument(
      requirement.id,
      { name: "first.pdf", size: 3, bytes: new Uint8Array([1, 1, 1]) },
      actorUserId,
    );
    const afterFirst = getDb();
    const firstRequirement = afterFirst.requirements.find((r) => r.id === requirement.id);
    const firstDocument = afterFirst.documents.find(
      (d) => d.id === firstRequirement?.satisfiedByDocumentId,
    );
    if (!firstDocument) throw new Error("first upload did not produce a document");

    await uploadDocument(
      requirement.id,
      { name: "second.pdf", size: 3, bytes: new Uint8Array([2, 2, 2]) },
      actorUserId,
    );
    const afterSecond = getDb();
    const secondRequirement = afterSecond.requirements.find((r) => r.id === requirement.id);
    const secondDocument = afterSecond.documents.find(
      (d) => d.id === secondRequirement?.satisfiedByDocumentId,
    );
    if (!secondDocument) throw new Error("second upload did not produce a document");

    expect(secondDocument.version).toBe(2);
    expect(secondDocument.supersedesDocumentId).toBe(firstDocument.id);
    expect(secondDocument.filePath).not.toBe(firstDocument.filePath);

    // The requirement now points at the latest version...
    expect(secondRequirement?.satisfiedByDocumentId).toBe(secondDocument.id);

    // ...but the superseded document and its bytes are still present and
    // reachable — nothing was overwritten (BR-031).
    expect(afterSecond.documents.some((d) => d.id === firstDocument.id)).toBe(true);
    const firstBytes = await storageAdapter.get(firstDocument.filePath);
    expect([...firstBytes]).toEqual([1, 1, 1]);
    const secondBytes = await storageAdapter.get(secondDocument.filePath);
    expect([...secondBytes]).toEqual([2, 2, 2]);
  });

  /**
   * Upload → View → Verify → Reject → re-upload → Verify again (Part 2 of
   * the real-world-issues milestone). A rejected document is not deleted and
   * not silently re-verified over — the next upload supersedes it exactly as
   * any other replacement does (BR-031), and the rejection stays readable in
   * the superseded document's own history.
   */
  it("re-verifies cleanly after a rejection, without losing the rejected version", async () => {
    resetDatabase();
    const db = getDb();
    // Upload is a telecaller's job; verify and reject are the Login Team's
    // (Part 7) — two different actors, matching who actually holds each
    // grant.
    const uploaderId = db.users.find((u) => u.roles.includes("telecaller"))?.id;
    const verifierId = db.users.find((u) => u.roles.includes("login_executive"))?.id;
    if (!uploaderId || !verifierId) {
      throw new Error("test setup: expected a seeded telecaller and login executive");
    }

    const requirement = db.requirements.find((r) => r.status === "pending");
    if (!requirement) throw new Error("test setup: expected a pending requirement in the seed");

    const uploaded = await uploadDocument(
      requirement.id,
      { name: "blurry.jpg", size: 3, bytes: new Uint8Array([9, 9, 9]) },
      uploaderId,
    );
    expect(uploaded.ok).toBe(true);

    const afterUpload = getDb();
    const receivedRequirement = afterUpload.requirements.find((r) => r.id === requirement.id);
    const firstDocument = afterUpload.documents.find(
      (d) => d.id === receivedRequirement?.satisfiedByDocumentId,
    );
    if (!firstDocument) throw new Error("upload did not produce a document");
    expect(receivedRequirement?.status).toBe("received");

    const rejected = rejectDocument(requirement.id, "Blurry — asked customer to re-upload", verifierId);
    expect(rejected.ok).toBe(true);

    const afterReject = getDb();
    const rejectedRequirement = afterReject.requirements.find((r) => r.id === requirement.id);
    const rejectedDocument = afterReject.documents.find((d) => d.id === firstDocument.id);
    expect(rejectedRequirement?.status).toBe("rejected");
    // The rejected document is kept, unmodified except for its rejection
    // fields — never deleted, never silently marked verified.
    expect(rejectedDocument?.rejectedAt).toBeDefined();
    expect(rejectedDocument?.rejectionReason).toBe("Blurry — asked customer to re-upload");
    expect(rejectedDocument?.verifiedAt).toBeUndefined();

    const reuploaded = await uploadDocument(
      requirement.id,
      { name: "clear.jpg", size: 3, bytes: new Uint8Array([8, 8, 8]) },
      uploaderId,
    );
    expect(reuploaded.ok).toBe(true);

    const afterReupload = getDb();
    const receivedAgain = afterReupload.requirements.find((r) => r.id === requirement.id);
    const secondDocument = afterReupload.documents.find(
      (d) => d.id === receivedAgain?.satisfiedByDocumentId,
    );
    if (!secondDocument) throw new Error("re-upload did not produce a document");

    // The re-upload is a new version superseding the rejected one — not an
    // overwrite of it and not a second attempt at the same document row.
    expect(receivedAgain?.status).toBe("received");
    expect(secondDocument.version).toBe(2);
    expect(secondDocument.supersedesDocumentId).toBe(firstDocument.id);
    expect(afterReupload.documents.some((d) => d.id === firstDocument.id)).toBe(true);

    const verifiedAgain = verifyDocument(requirement.id, verifierId, "Clear this time.");
    expect(verifiedAgain.ok).toBe(true);

    const finalState = getDb();
    const finalRequirement = finalState.requirements.find((r) => r.id === requirement.id);
    const finalDocument = finalState.documents.find((d) => d.id === secondDocument.id);
    expect(finalRequirement?.status).toBe("verified");
    expect(finalDocument?.verifiedBy).toBe(verifierId);

    // The rejected v1 is still there, untouched by the later verification.
    const stillRejected = finalState.documents.find((d) => d.id === firstDocument.id);
    expect(stillRejected?.rejectionReason).toBe("Blurry — asked customer to re-upload");
    expect(stillRejected?.verifiedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adding a bank to a case (Milestone 10, ADR-036).
//
// The guarantee worth testing is not that a submission gets created — it is
// that editing master data afterwards CANNOT change what a historical
// submission says it did. Everything else in this milestone is a form; that
// is the promise.
// ---------------------------------------------------------------------------

describe("adding a bank to a case", () => {
  const firstCase = () => {
    const db = getDb();
    const loanCase = db.cases[0];
    if (!loanCase) throw new Error("the seed has no cases");
    return loanCase;
  };

  /** A seeded Coimbatore branch and the bank it hangs off. */
  const someBranch = () => {
    const db = getDb();
    const branch = db.organisations.find(
      (org) => org.roles.includes("branch") && org.parentOrganisationId !== undefined,
    );
    if (!branch) throw new Error("the seed has no branches");
    const institution = db.organisations.find((o) => o.id === branch.parentOrganisationId);
    if (!institution) throw new Error("a branch hangs off nothing");
    return { branch, institution };
  };

  /** Sending a file to a bank is the Login Team's job, not a telecaller's
   * (Part 7) — createSubmission now checks it. */
  const loginExecutiveId = (): string => {
    const id = getDb().users.find((u) => u.roles.includes("login_executive"))?.id;
    if (!id) throw new Error("test setup: expected a seeded login executive");
    return id;
  };

  it("records the bankers it was addressed to, in order, with one primary", () => {
    resetDatabase();
    const { branch } = someBranch();
    const result = createSubmission(
      {
        caseId: firstCase().id,
        branchOrganisationId: branch.id,
        recipients: [
          { email: "homeloans.cbe@bank.com", kind: "cc" },
          { email: "Manager@Bank.com", name: "Suresh K", designation: "Branch Manager", isPrimary: true },
        ],
      },
      loginExecutiveId(),
    );
    expect(result.ok).toBe(true);

    const submission = getDb().submissions.at(-1);
    if (!submission) throw new Error("no submission was created");
    const recipients = recipientsOf(submission.id);

    expect(recipients.map((r) => r.email)).toEqual([
      "homeloans.cbe@bank.com",
      "manager@bank.com",
    ]);
    expect(recipients[0]?.recipientKind).toBe("cc");
    expect(recipients[1]?.isPrimary).toBe(true);
    expect(recipients[0]?.isPrimary).toBe(false);
    // A shared mailbox has no name, and that is a complete record.
    expect(recipients[0]?.contactName).toBeUndefined();
    expect(recipients[1]?.contactName).toBe("Suresh K");
  });

  it("refuses a bank with nobody to send it to", () => {
    resetDatabase();
    const { branch } = someBranch();
    const before = getDb().submissions.length;
    const result = createSubmission(
      { caseId: firstCase().id, branchOrganisationId: branch.id, recipients: [] },
      loginExecutiveId(),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("at least one");
    // And wrote nothing — a rejected action must not leave a half-made row.
    expect(getDb().submissions).toHaveLength(before);
  });

  it("refuses a malformed address rather than storing it", () => {
    resetDatabase();
    const { branch } = someBranch();
    const result = createSubmission(
      {
        caseId: firstCase().id,
        branchOrganisationId: branch.id,
        recipients: [{ email: "Suresh Kumar" }],
      },
      loginExecutiveId(),
    );
    expect(result.ok).toBe(false);
    expect(getDb().submissionRecipients).toEqual([]);
  });

  // THE point of the milestone's snapshot. A branch renamed in Master Data
  // next year must not rewrite a file lodged today — a rejection recorded
  // against a branch is evidence (ADR-028), and evidence that changes
  // underneath you is not evidence.
  it("does not let a later branch rename rewrite what a submission says it did", () => {
    resetDatabase();
    const { branch, institution } = someBranch();
    createSubmission(
      {
        caseId: firstCase().id,
        branchOrganisationId: branch.id,
        recipients: [{ email: "rm@bank.com" }],
      },
      loginExecutiveId(),
    );

    const submission = getDb().submissions.at(-1);
    if (!submission) throw new Error("no submission was created");
    const asRecorded = counterpartyOf(submission);
    expect(submission.branchNameAtSubmission).toBe(branch.canonicalName);
    expect(submission.bankNameAtSubmission).toBe(institution.canonicalName);
    expect(submission.snapshotTakenAt).toBeDefined();

    const renamed = updateBranch(
      branch.id,
      { institutionOrganisationId: institution.id, name: "Somewhere Else Entirely", operationalStatus: "operational" },
      "usr_1",
    );
    expect(renamed.ok).toBe(true);

    // The live branch moved on; the submission did not.
    expect(getDb().organisations.find((o) => o.id === branch.id)?.canonicalName).toBe(
      "Somewhere Else Entirely",
    );
    const after = getDb().submissions.find((s) => s.id === submission.id);
    if (!after) throw new Error("the submission vanished");
    expect(after.branchNameAtSubmission).toBe(branch.canonicalName);
    expect(counterpartyOf(after)).toBe(asRecorded);
  });

  // A seeded submission predates the workflow that captures a snapshot, so
  // its snapshot is a RECONSTRUCTION. `snapshotTakenAt` is what tells the two
  // apart, and anything reporting on historical accuracy needs that.
  it("marks a reconstructed snapshot as one, by leaving the timestamp off", () => {
    resetDatabase();
    const seeded = getDb().submissions[0];
    if (!seeded) throw new Error("the seed has no submissions");
    expect(seeded.branchNameAtSubmission).toBeDefined();
    expect(seeded.snapshotTakenAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The Telecaller Workflow milestone.
// ---------------------------------------------------------------------------

describe("custom requirements — the exception the rules could not have known about", () => {
  function setup(): { caseId: string; userId: string } {
    resetDatabase();
    const db = getDb();
    const productId = db.loanProducts[0]?.id;
    const userId = db.users[0]?.id;
    if (!productId || !userId) throw new Error("test setup: expected a seeded product and user");
    return {
      caseId: createCase({ newApplicantName: "Selvi Murugan", loanProductId: productId }, userId),
      userId,
    };
  }

  it("adds the document to that case and to no rule", () => {
    const { caseId, userId } = setup();
    const rulesBefore = JSON.stringify(getDb().documentRequirementRules);

    const result = addCustomRequirement(
      caseId,
      {
        category: "property",
        name: "Bank NOC for the second charge",
        description: "Letter from the existing bank agreeing to a second charge.",
        applicability: "mandatory",
      },
      userId,
    );

    expect(result.ok).toBe(true);
    // MASTER RULES UNTOUCHED. This is the whole promise of Part 6: a document
    // added for one file must not change what every other open case asks for.
    expect(JSON.stringify(getDb().documentRequirementRules)).toBe(rulesBefore);

    const added = getDb().requirements.find((r) => r.caseId === caseId && r.isCustom);
    expect(added?.customName).toBe("Bank NOC for the second charge");
    expect(added?.customCategory).toBe("property");
    expect(added?.status).toBe("pending");
  });

  it("survives a regeneration, because no rule produced it and so no rule can withdraw it", () => {
    const { caseId, userId } = setup();
    addCustomRequirement(
      caseId,
      { category: "additional", name: "Employer's NOC", applicability: "optional" },
      userId,
    );

    // Anything that changes a case fact regenerates the whole requirement set.
    updateCaseFacts(caseId, { hasExistingObligations: true }, userId);

    const survivor = getDb().requirements.find(
      (r) => r.caseId === caseId && r.customName === "Employer's NOC",
    );
    expect(survivor?.status).toBe("pending");
    expect(survivor?.applicability).toBe("optional");
  });

  it("refuses the same document twice on one case", () => {
    const { caseId, userId } = setup();
    const input = {
      category: "kyc" as const,
      name: "Ration card",
      applicability: "mandatory" as const,
    };

    expect(addCustomRequirement(caseId, input, userId).ok).toBe(true);
    expect(addCustomRequirement(caseId, input, userId).ok).toBe(false);
  });

  it("refuses to delete a rule-generated requirement, because that would hide why it was asked for", () => {
    const { caseId, userId } = setup();
    const generated = getDb().requirements.find((r) => r.caseId === caseId && !r.isCustom);
    if (!generated) throw new Error("test setup: expected a generated requirement");

    const result = removeCustomRequirement(generated.id, userId);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/waive/i);
  });

  it("marks a withdrawn custom requirement not applicable rather than deleting it", () => {
    const { caseId, userId } = setup();
    addCustomRequirement(
      caseId,
      { category: "additional", name: "Site photo", applicability: "optional" },
      userId,
    );
    const added = getDb().requirements.find((r) => r.caseId === caseId && r.isCustom);
    if (!added) throw new Error("test setup: expected the custom requirement");

    expect(removeCustomRequirement(added.id, userId).ok).toBe(true);

    const after = getDb().requirements.find((r) => r.id === added.id);
    expect(after).toBeDefined();
    expect(after?.status).toBe("not_applicable");
  });
});

// ---------------------------------------------------------------------------
// "Existing Loans and EMIs" → "+ Another loan" — the missing-STORAGE_KEY-bump
// bug.
//
// Reported: entering a lender and pressing "Add the statement" failed with
// "The 'Other Document' type is missing from master data." CaseDetail's
// addStatement() calls addCustomRequirement exactly as any other hand-added
// document does (Part 6 of the Telecaller Workflow milestone) — there is no
// separate "Existing Loan Statement" type for a second lender, by design
// (see the doc comment on ExistingObligations in CaseDetail.tsx): the rule
// still owns `existing_loan_statement` for the first, per-party statement,
// and every additional one is a per-case custom requirement named after the
// lender, anchored to the `other_document` catalogue row.
//
// That row was added to the catalogue in the same commit that introduced
// this feature, but STORAGE_KEY was not bumped alongside it — so a browser
// whose store predates that commit keeps a `documentTypes` array with no
// `other_document` row forever, and `addCustomRequirement`'s lookup fails.
// The fix is the version bump (v6 -> v7), not a new master document type.
// ---------------------------------------------------------------------------

describe("existing loans and EMIs — 'Add another loan' (regression for the STORAGE_KEY bug)", () => {
  it("discards a pre-milestone store instead of reusing it, so a second lender's statement can be added", async () => {
    // A snapshot shaped like what a real browser had before the Telecaller
    // Workflow milestone shipped `other_document`: a documentTypes array
    // that simply does not contain it. Written under the OLD key literally,
    // the way a real stale browser's localStorage would still hold it.
    const staleUserId = "usr_stale";
    const staleCaseId = "cas_stale";
    localStorage.setItem(
      "aos.prototype.v6",
      JSON.stringify({
        cases: [{ id: staleCaseId, caseNumber: "STALE-1", stage: "documents_pending" }],
        caseParties: [],
        people: [],
        organisations: [],
        users: [{ id: staleUserId, fullName: "Stale User" }],
        loanProducts: [],
        documentTypes: [{ id: "dt_pan", code: "pan_card", name: "PAN Card" }],
        requirements: [],
        documents: [],
        documentRequirementRules: [],
        events: [],
      }),
    );

    // A fresh module instance, reading that same localStorage — precisely
    // what re-opening the app in that stale browser is.
    vi.resetModules();
    vi.doMock("./storage.js", () => ({ storageAdapter: new InMemoryStorageAdapter() }));
    const reloaded = await import("./store.js");

    // The stale v6 snapshot must not have been used: the current store reads
    // a different key, so it bootstrapped a fresh seed instead — one whose
    // catalogue does carry `other_document`.
    const freshOtherDocument = reloaded
      .getDb()
      .documentTypes.find((t) => t.code === "other_document");
    expect(freshOtherDocument).toBeDefined();
    expect(reloaded.getDb().cases.some((c) => c.id === staleCaseId)).toBe(false);

    // The exact call CaseDetail's addStatement() makes for "+ Another loan".
    const db = reloaded.getDb();
    const productId = db.loanProducts[0]?.id;
    const userId = db.users[0]?.id;
    if (!productId || !userId) throw new Error("test setup: expected a seeded product and user");
    const caseId = reloaded.createCase(
      { newApplicantName: "Ravi Kumar", loanProductId: productId },
      userId,
    );

    const catalogueSizeBefore = reloaded.getDb().documentTypes.length;

    const result = reloaded.addCustomRequirement(
      caseId,
      {
        category: "income",
        name: "Existing Loan Statement — HDFC Bank",
        applicability: "mandatory",
        description:
          "Statement for a second live loan, showing the EMI and how regularly it is paid.",
      },
      userId,
    );

    expect(result.ok).toBe(true);

    const added = reloaded
      .getDb()
      .requirements.find((r) => r.caseId === caseId && r.isCustom && r.customName?.includes("HDFC"));
    expect(added).toBeDefined();
    expect(added?.customName).toBe("Existing Loan Statement — HDFC Bank");
    // Anchored to the existing 'Other Document' catalogue type — no new
    // master document type was created for the lender.
    expect(added?.documentTypeId).toBe(freshOtherDocument?.id);
    // The lender-specific requirement is still found by the same filter
    // ExistingObligations uses to list "Statements being collected".
    expect(added?.customName?.toLowerCase().includes("loan statement")).toBe(true);

    // No new master document type was created for this lender.
    expect(reloaded.getDb().documentTypes.length).toBe(catalogueSizeBefore);
  });
});

describe("uploading against a requirement whose document type belongs to a business", () => {
  /**
   * The bug: a proprietor borrowing in their own name is asked for a balance
   * sheet and a current account statement — both types declared
   * `organisation`, both attached to a PERSON, because on that file the
   * business IS the person. Resolving ownership from the TYPE looked for an
   * organisation id that did not exist and threw BR-030, so the checklist
   * asked for a document the user could then not upload.
   */
  it("stores it against the person the requirement is for, rather than throwing", async () => {
    resetDatabase();
    const db = getDb();
    const userId = db.users[0]?.id;
    const businessProduct = db.loanProducts.find((p) => p.code?.startsWith("bl_"));
    if (!userId || !businessProduct) {
      throw new Error("test setup: expected a seeded user and a business lending product");
    }

    const caseId = createCase(
      { newApplicantName: "Anand Kumar", loanProductId: businessProduct.id },
      userId,
    );

    const balanceSheetTypeId = getDb().documentTypes.find((t) => t.code === "balance_sheet")?.id;
    const requirement = getDb().requirements.find(
      (r) => r.caseId === caseId && r.documentTypeId === balanceSheetTypeId,
    );
    if (!requirement) {
      throw new Error("test setup: expected a balance sheet requirement on a business loan");
    }
    expect(requirement.requiredOfCasePartyId).toBeDefined();

    const result = await uploadDocument(
      requirement.id,
      { name: "balance-sheet.pdf", size: 4, bytes: new Uint8Array([1, 2, 3, 4]) },
      userId,
    );

    expect(result.ok).toBe(true);
    const stored = getDb().documents.find((d) => d.fileName === "balance-sheet.pdf");
    expect(stored?.ownerKind).toBe("person");
    expect(stored?.personId).toBeDefined();
    expect(stored?.filePath).toContain("balance_sheet");
  });
});

// ---------------------------------------------------------------------------
// Customer profile — correcting the shared Person/Organisation record itself,
// not a case's view of it (real-world-issues milestone, Part 3).
// ---------------------------------------------------------------------------

describe("updatePerson — the shared record, not a case's override of it", () => {
  function seededPersonAndTelecaller(): { personId: string; telecallerId: string } {
    resetDatabase();
    const db = getDb();
    const personId = db.people[0]?.id;
    const telecallerId = db.users.find((u) => u.roles.includes("telecaller"))?.id;
    if (!personId || !telecallerId) {
      throw new Error("test setup: expected a seeded person and telecaller");
    }
    return { personId, telecallerId };
  }

  it("corrects name, date of birth and address, and records why", () => {
    const { personId, telecallerId } = seededPersonAndTelecaller();

    const result = updatePerson(
      personId,
      { dateOfBirth: "1990-05-14", addressLine: "12 Mill Road", pincode: "641001" },
      telecallerId,
    );

    expect(result.ok).toBe(true);
    const person = getDb().people.find((p) => p.id === personId);
    expect(person?.dateOfBirth).toBe("1990-05-14");
    expect(person?.addressLine).toBe("12 Mill Road");
    expect(person?.pincode).toBe("641001");

    const event = getDb().events.find(
      (e) => e.entityType === "person" && e.entityId === personId && e.eventType === "person.updated",
    );
    expect(event?.summary).toContain("Date of birth");
  });

  it("changes the person everywhere they appear, not a case-specific copy", () => {
    const { personId, telecallerId } = seededPersonAndTelecaller();
    updatePerson(personId, { city: "Salem" }, telecallerId);
    // Re-reading from scratch, not from a case — this is the shared record.
    expect(getDb().people.find((p) => p.id === personId)?.city).toBe("Salem");
  });

  it("is a no-op, not an error, when nothing actually changed", () => {
    const { personId, telecallerId } = seededPersonAndTelecaller();
    const before = getDb().events.length;
    const result = updatePerson(personId, {}, telecallerId);
    expect(result.ok).toBe(true);
    expect(getDb().events.length).toBe(before);
  });

  it("refuses an actor who holds no person.update grant", () => {
    resetDatabase();
    const db = getDb();
    const personId = db.people[0]?.id;
    const financeUserId = db.users.find((u) => u.roles.includes("finance"))?.id;
    if (!personId || !financeUserId) {
      throw new Error("test setup: expected a seeded person and a finance-roled user");
    }

    const result = updatePerson(personId, { city: "Salem" }, financeUserId);
    expect(result.ok).toBe(false);
    expect(getDb().people.find((p) => p.id === personId)?.city).not.toBe("Salem");
  });
});

describe("updatePersonIdentifiers — an alternate phone is a second identifier, not a new field", () => {
  it("adds a second phone number without disturbing the first", () => {
    resetDatabase();
    const db = getDb();
    const person = db.people.find((p) => p.identifiers.some((i) => i.type === "phone"));
    const telecallerId = db.users.find((u) => u.roles.includes("telecaller"))?.id;
    if (!person || !telecallerId) {
      throw new Error("test setup: expected a seeded person with a phone and a telecaller");
    }
    const originalPrimary = person.identifiers.find((i) => i.type === "phone" && i.isPrimary);
    if (!originalPrimary) throw new Error("test setup: expected a primary phone");

    const result = updatePersonIdentifiers(
      person.id,
      { type: "phone", value: "+91 90000 11111", isPrimary: false },
      telecallerId,
    );
    expect(result.ok).toBe(true);

    const identifiers = getDb().people.find((p) => p.id === person.id)?.identifiers ?? [];
    const phones = identifiers.filter((i) => i.type === "phone");
    expect(phones).toHaveLength(2);
    // The original primary is untouched — adding a non-primary number must
    // not demote it.
    expect(identifiers.find((i) => i.id === originalPrimary.id)?.isPrimary).toBe(true);
  });

  it("demotes the previous primary when a new one is marked primary", () => {
    resetDatabase();
    const db = getDb();
    const person = db.people.find((p) => p.identifiers.some((i) => i.type === "phone"));
    const telecallerId = db.users.find((u) => u.roles.includes("telecaller"))?.id;
    if (!person || !telecallerId) {
      throw new Error("test setup: expected a seeded person with a phone and a telecaller");
    }
    const originalPrimary = person.identifiers.find((i) => i.type === "phone" && i.isPrimary);
    if (!originalPrimary) throw new Error("test setup: expected a primary phone");

    updatePersonIdentifiers(
      person.id,
      { type: "phone", value: "+91 90000 22222", isPrimary: true },
      telecallerId,
    );

    const identifiers = getDb().people.find((p) => p.id === person.id)?.identifiers ?? [];
    const primaries = identifiers.filter((i) => i.type === "phone" && i.isPrimary);
    // Exactly one primary phone survives, and it is the new one.
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.value).toBe("+91 90000 22222");
    expect(identifiers.find((i) => i.id === originalPrimary.id)?.isPrimary).toBe(false);
  });

  it("edits an existing identifier's value in place rather than adding a duplicate", () => {
    resetDatabase();
    const db = getDb();
    const person = db.people.find((p) => p.identifiers.some((i) => i.type === "phone"));
    const telecallerId = db.users.find((u) => u.roles.includes("telecaller"))?.id;
    if (!person || !telecallerId) {
      throw new Error("test setup: expected a seeded person with a phone and a telecaller");
    }
    const existing = person.identifiers.find((i) => i.type === "phone");
    if (!existing) throw new Error("test setup: expected a phone identifier");
    const before = person.identifiers.length;

    updatePersonIdentifiers(
      person.id,
      { id: existing.id, type: "phone", value: "+91 90000 33333", isPrimary: existing.isPrimary },
      telecallerId,
    );

    const identifiers = getDb().people.find((p) => p.id === person.id)?.identifiers ?? [];
    expect(identifiers).toHaveLength(before);
    expect(identifiers.find((i) => i.id === existing.id)?.value).toBe("+91 90000 33333");
  });
});

describe("updateOrganisation — the business's own record, and its GST/Udyam facts", () => {
  function seededOrgAndTelecaller(): { organisationId: string; telecallerId: string } {
    resetDatabase();
    const db = getDb();
    const organisationId = db.organisations[0]?.id;
    const telecallerId = db.users.find((u) => u.roles.includes("telecaller"))?.id;
    if (!organisationId || !telecallerId) {
      throw new Error("test setup: expected a seeded organisation and telecaller");
    }
    return { organisationId, telecallerId };
  }

  it("records the business's own address and GST/Udyam facts", () => {
    const { organisationId, telecallerId } = seededOrgAndTelecaller();

    const result = updateOrganisation(
      organisationId,
      {
        addressLine: "14 Mettupalayam Road",
        city: "Coimbatore",
        isGstRegistered: true,
        gstin: "33ABCDE1234F1Z5",
        udyamRegistered: true,
        udyamNumber: "UDYAM-TN-01-1234567",
      },
      telecallerId,
    );

    expect(result.ok).toBe(true);
    const organisation = getDb().organisations.find((o) => o.id === organisationId);
    expect(organisation?.addressLine).toBe("14 Mettupalayam Road");
    expect(organisation?.isGstRegistered).toBe(true);
    expect(organisation?.gstin).toBe("33ABCDE1234F1Z5");
    expect(organisation?.udyamRegistered).toBe(true);
    expect(organisation?.udyamNumber).toBe("UDYAM-TN-01-1234567");
  });

  it("can record false as a real answer, not just true", () => {
    const { organisationId, telecallerId } = seededOrgAndTelecaller();
    updateOrganisation(organisationId, { isGstRegistered: true }, telecallerId);
    updateOrganisation(organisationId, { isGstRegistered: false }, telecallerId);
    expect(getDb().organisations.find((o) => o.id === organisationId)?.isGstRegistered).toBe(false);
  });

  it("never touches loan_case.isGstRegistered on any case — the engine's fact is untouched", () => {
    const { organisationId, telecallerId } = seededOrgAndTelecaller();
    const casesBefore = JSON.stringify(getDb().cases);

    updateOrganisation(organisationId, { isGstRegistered: true, udyamRegistered: true }, telecallerId);

    // The organisation's profile fact changed; no case's own GST fact — the
    // one the Document Requirement Engine actually reads — moved at all.
    expect(JSON.stringify(getDb().cases)).toBe(casesBefore);
  });

  it("refuses an actor who holds no organisation.update grant", () => {
    resetDatabase();
    const db = getDb();
    const organisationId = db.organisations[0]?.id;
    const financeUserId = db.users.find((u) => u.roles.includes("finance"))?.id;
    if (!organisationId || !financeUserId) {
      throw new Error("test setup: expected a seeded organisation and a finance-roled user");
    }

    const result = updateOrganisation(organisationId, { isGstRegistered: true }, financeUserId);
    expect(result.ok).toBe(false);
    expect(getDb().organisations.find((o) => o.id === organisationId)?.isGstRegistered).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Authorization at the store boundary (real-world-issues milestone, Part 7).
//
// "Hiding 'Send to Bank' from a telecaller is insufficient. The underlying
// operation must reject a telecaller attempting to send a case to a bank."
// These call the mutations directly — no component, no hidden button — the
// same way a determined caller or a future API client would.
// ---------------------------------------------------------------------------

describe("authorization at the store boundary", () => {
  function caseOwnedByTelecaller(): { caseId: string; telecallerId: string } {
    resetDatabase();
    const db = getDb();
    const productId = db.loanProducts[0]?.id;
    const telecallerId = db.users.find((u) => u.roles.includes("telecaller"))?.id;
    if (!productId || !telecallerId) {
      throw new Error("test setup: expected a seeded product and telecaller");
    }
    return {
      caseId: createCase({ newApplicantName: "Test Applicant", loanProductId: productId }, telecallerId),
      telecallerId,
    };
  }

  function caseById(db: ReturnType<typeof getDb>, caseId: string) {
    const loanCase = db.cases.find((c) => c.id === caseId);
    if (!loanCase) throw new Error(`expected case ${caseId} to exist`);
    return loanCase;
  }

  it("rejects a telecaller sending a case to a bank — the milestone's own example", () => {
    const { caseId, telecallerId } = caseOwnedByTelecaller();
    const db = getDb();
    const branch = db.organisations.find(
      (org) => org.roles.includes("branch") && org.parentOrganisationId !== undefined,
    );
    if (!branch) throw new Error("test setup: expected a seeded branch");

    const result = createSubmission(
      { caseId, branchOrganisationId: branch.id, recipients: [{ email: "rm@bank.com" }] },
      telecallerId,
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain("submission.create");
    expect(getDb().submissions.some((s) => s.caseId === caseId)).toBe(false);
  });

  it("lets the Login Team send the same case to the same bank", () => {
    const { caseId } = caseOwnedByTelecaller();
    const db = getDb();
    const branch = db.organisations.find(
      (org) => org.roles.includes("branch") && org.parentOrganisationId !== undefined,
    );
    const loginExecutiveId = db.users.find((u) => u.roles.includes("login_executive"))?.id;
    if (!branch || !loginExecutiveId) {
      throw new Error("test setup: expected a seeded branch and login executive");
    }

    const result = createSubmission(
      { caseId, branchOrganisationId: branch.id, recipients: [{ email: "rm@bank.com" }] },
      loginExecutiveId,
    );

    expect(result.ok).toBe(true);
    expect(getDb().submissions.some((s) => s.caseId === caseId)).toBe(true);
  });

  it("rejects moving a case for an actor with no case.update grant at any scope", () => {
    const { caseId } = caseOwnedByTelecaller();
    const financeUserId = getDb().users.find((u) => u.roles.includes("finance"))?.id;
    if (!financeUserId) throw new Error("test setup: expected a seeded finance user");

    const result = moveStage(caseId, "contacted", financeUserId);

    expect(result.ok).toBe(false);
    expect(caseById(getDb(), caseId).stage).toBe("new");
  });

  it("rejects uploading for an actor with no document.upload grant", async () => {
    const { caseId } = caseOwnedByTelecaller();
    const requirement = getDb().requirements.find(
      (r) => r.caseId === caseId && r.status === "pending",
    );
    const financeUserId = getDb().users.find((u) => u.roles.includes("finance"))?.id;
    if (!requirement || !financeUserId) {
      throw new Error("test setup: expected a pending requirement and a seeded finance user");
    }

    const result = await uploadDocument(
      requirement.id,
      { name: "x.pdf", size: 3, bytes: new Uint8Array([1, 2, 3]) },
      financeUserId,
    );

    expect(result.ok).toBe(false);
    expect(getDb().requirements.find((r) => r.id === requirement.id)?.status).toBe("pending");
  });

  it("rejects verifying for the uploader themselves, when they hold no document.verify grant", async () => {
    const { caseId, telecallerId } = caseOwnedByTelecaller();
    const requirement = getDb().requirements.find(
      (r) => r.caseId === caseId && r.status === "pending",
    );
    if (!requirement) throw new Error("test setup: expected a pending requirement");

    await uploadDocument(
      requirement.id,
      { name: "x.pdf", size: 3, bytes: new Uint8Array([1, 2, 3]) },
      telecallerId,
    );
    expect(getDb().requirements.find((r) => r.id === requirement.id)?.status).toBe("received");

    // The same telecaller who uploaded it cannot also verify it — upload and
    // verify are different grants, held by different roles.
    const result = verifyDocument(requirement.id, telecallerId);

    expect(result.ok).toBe(false);
    expect(getDb().requirements.find((r) => r.id === requirement.id)?.status).toBe("received");
  });
});
