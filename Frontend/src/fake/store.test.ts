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
  counterpartyOf,
  createCase,
  createSubmission,
  getDb,
  recipientsOf,
  removeCustomRequirement,
  resetDatabase,
  updateBranch,
  updateCaseFacts,
  uploadDocument,
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
      "usr_1",
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
      "usr_1",
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
      "usr_1",
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
      "usr_1",
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
