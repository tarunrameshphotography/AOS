import { describe, expect, it, vi } from "vitest";

import { DOCUMENT_CATALOGUE } from "@domain/requirements/index.js";

import { InMemoryStorageAdapter } from "./storage.mock.js";

/**
 * The case workflow, end to end (Case Workflow Completion, Part 13).
 *
 * WHAT THESE TESTS ARE FOR
 *
 * A telecaller opens a case on a call, types in what the customer says, walks
 * through Overview → Documents → Banks → Timeline collecting as they go, and
 * comes back to it tomorrow. Every step of that has to keep what was entered.
 * The failures worth catching are the quiet ones: a fact that saves and then
 * is not there, a checklist that does not change when the fact behind it does,
 * a case that looks finished because files were uploaded, a hand-added
 * document that turns up on somebody else's case.
 *
 * WHY THEY ARE AT THIS LEVEL AND NOT IN A RENDERED BROWSER
 *
 * Nothing here reaches for a component or a router. The case screen holds no
 * state of its own worth testing — the section is a URL parameter (covered by
 * screens/case-tabs.test.ts) and every edit is written straight through to the
 * store the moment it is made. So "does navigating lose my data?" is really
 * "does the store still hold it?", and that is a question this file can ask
 * honestly without a DOM.
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

vi.doMock("./storage.js", () => ({ storageAdapter: new InMemoryStorageAdapter() }));

const {
  addCustomRequirement,
  addNote,
  createCase,
  getDb,
  moveStage,
  progressFor,
  resetDatabase,
  updateCaseFacts,
  uploadDocument,
  verifyDocument,
} = await import("./store.js");
const { storageAdapter } = await import("./storage.js");

interface Fixture {
  caseId: string;
  userId: string;
  productId: string;
}

function setup(name = "Meena Rajendran"): Fixture {
  resetDatabase();
  const db = getDb();
  const productId = db.loanProducts[0]?.id;
  const userId = db.users[0]?.id;
  if (!productId || !userId) throw new Error("test setup: expected a seeded product and user");
  return {
    caseId: createCase({ newApplicantName: name, loanProductId: productId }, userId),
    userId,
    productId,
  };
}

function caseById(caseId: string) {
  const loanCase = getDb().cases.find((c) => c.id === caseId);
  if (!loanCase) throw new Error(`expected case ${caseId} to exist`);
  return loanCase;
}

function requirementsOf(caseId: string) {
  return getDb().requirements.filter((r) => r.caseId === caseId);
}

/**
 * Walk the case to the stage at which its documents are due.
 *
 * A brand new case is at `new`, and almost every requirement becomes
 * applicable from `documents_pending` — before that they are real but not yet
 * due, and are deliberately reported as upcoming rather than missing. Anything
 * asking about outstanding documents therefore has to get the case there
 * first, the same way a telecaller does: contacted, then collecting.
 */
function openForDocuments(caseId: string, userId: string): void {
  for (const stage of ["contacted", "documents_pending"] as const) {
    const result = moveStage(caseId, stage, userId);
    if (!result.ok) throw new Error(`test setup: could not reach ${stage} — ${result.message}`);
  }
}

/** A requirement that can actually be uploaded against, whatever the seed order. */
function anyPendingRequirementId(caseId: string): string {
  const pending = requirementsOf(caseId).find((r) => r.status === "pending");
  if (!pending) throw new Error("expected the new case to be asking for something");
  return pending.id;
}

const FILE = {
  name: "pan.png",
  size: 4,
  bytes: new Uint8Array([1, 2, 3, 4]),
  contentType: "image/png",
};

// ---------------------------------------------------------------------------
// 1–2. Creating a case, and opening the one that was created
// ---------------------------------------------------------------------------

describe("creating a case and opening it", () => {
  it("opens with a number, an owner, an applicant and a checklist", () => {
    const { caseId, userId, productId } = setup();
    const loanCase = caseById(caseId);

    expect(loanCase.caseNumber).toMatch(/^AL-\d{4}-\d{5}$/);
    expect(loanCase.ownerUserId).toBe(userId);
    expect(loanCase.stage).toBe("new");
    expect(loanCase.loanProductId).toBe(productId);

    const parties = getDb().caseParties.filter((p) => p.caseId === caseId);
    expect(parties).toHaveLength(1);
    expect(parties[0]?.isPrimary).toBe(true);

    // A case that generates nothing has no workflow to complete, and would
    // hide every requirement bug behind an empty list.
    expect(requirementsOf(caseId).length).toBeGreaterThan(0);
  });

  it("opens the case that was just created, and never an earlier one", () => {
    const first = setup("First Applicant");
    const secondId = createCase(
      { newApplicantName: "Second Applicant", loanProductId: first.productId },
      first.userId,
    );

    expect(secondId).not.toBe(first.caseId);
    expect(caseById(secondId).caseNumber).not.toBe(caseById(first.caseId).caseNumber);

    // Opening the second must leave the first exactly as it was — the P0 bug
    // was a lookup that returned the older row for a newer id.
    const applicantOf = (caseId: string): string | undefined => {
      const party = getDb().caseParties.find((p) => p.caseId === caseId && p.isPrimary);
      return getDb().people.find((p) => p.id === party?.personId)?.fullName;
    };
    expect(applicantOf(first.caseId)).toBe("First Applicant");
    expect(applicantOf(secondId)).toBe("Second Applicant");
  });
});

// ---------------------------------------------------------------------------
// 3–4, 8. Editing facts, saving an incomplete case, and coming back
// ---------------------------------------------------------------------------

describe("entering the facts a case is made of", () => {
  it("keeps every fact that was entered, one at a time, without clearing the others", () => {
    const { caseId, userId } = setup();

    updateCaseFacts(caseId, { requestedAmount: 1_500_000 }, userId);
    updateCaseFacts(caseId, { requestedAmount: 1_500_000, isGstRegistered: true }, userId);
    updateCaseFacts(
      caseId,
      { requestedAmount: 1_500_000, isGstRegistered: true, hasExistingObligations: true },
      userId,
    );

    const loanCase = caseById(caseId);
    expect(loanCase.requestedAmount).toBe(1_500_000);
    expect(loanCase.isGstRegistered).toBe(true);
    expect(loanCase.hasExistingObligations).toBe(true);
  });

  it("keeps 'not asked' as its own answer, distinct from no", () => {
    const { caseId, userId } = setup();

    expect(caseById(caseId).hasExistingObligations).toBeUndefined();

    updateCaseFacts(caseId, { hasExistingObligations: false }, userId);
    expect(caseById(caseId).hasExistingObligations).toBe(false);

    // Clearing an answer back to unasked is a legitimate correction.
    updateCaseFacts(caseId, {}, userId);
    expect(caseById(caseId).hasExistingObligations).toBeUndefined();
  });

  it("saves an incomplete case — nothing is refused for want of documents", () => {
    const { caseId, userId } = setup();
    openForDocuments(caseId, userId);

    // The normal state of a case being worked: outstanding documents, and most
    // facts still unanswered.
    expect(progressFor(caseId).outstandingCount).toBeGreaterThan(0);

    const result = updateCaseFacts(caseId, { requestedAmount: 800_000 }, userId);
    expect(result.ok).toBe(true);
    expect(caseById(caseId).requestedAmount).toBe(800_000);

    const note = addNote(caseId, "Customer will send the payslip on Monday.", userId);
    expect(note.ok).toBe(true);

    // And saving did not quietly march the case forward.
    expect(caseById(caseId).stage).toBe("documents_pending");
  });

  it("loses nothing when the case is left and returned to, including across a reload", async () => {
    const { caseId, userId } = setup();
    updateCaseFacts(
      caseId,
      { requestedAmount: 2_400_000, isGstRegistered: true, hasExistingObligations: true },
      userId,
    );
    addNote(caseId, "Prefers a call after 6pm.", userId);

    const before = JSON.stringify(caseById(caseId));
    const notesBefore = getDb().notes.filter((n) => n.caseId === caseId).length;

    // Reading other rows — which is all that switching sections does — must
    // not disturb the case.
    getDb().submissions.filter((s) => s.caseId === caseId);
    getDb().events.filter((e) => e.caseId === caseId);
    expect(JSON.stringify(caseById(caseId))).toBe(before);

    // A refresh is a reload from localStorage, and the case has to survive it.
    vi.resetModules();
    const reloaded = await import("./store.js");
    const after = reloaded.getDb().cases.find((c) => c.id === caseId);
    expect(after?.requestedAmount).toBe(2_400_000);
    expect(after?.isGstRegistered).toBe(true);
    expect(after?.hasExistingObligations).toBe(true);
    expect(reloaded.getDb().notes.filter((n) => n.caseId === caseId)).toHaveLength(notesBefore);
  });
});

// ---------------------------------------------------------------------------
// 9. Requirements follow the facts
// ---------------------------------------------------------------------------

describe("changing a fact changes what is asked for", () => {
  const statementRows = (caseId: string) => {
    const type = getDb().documentTypes.find((t) => t.code === "existing_loan_statement");
    return requirementsOf(caseId).filter(
      (r) => r.documentTypeId === type?.id && r.status !== "not_applicable",
    );
  };

  it("asks for an existing loan statement only once somebody says there is a loan", () => {
    const { caseId, userId } = setup();

    // Unasked generates nothing. Silence is not a no and not a yes.
    expect(statementRows(caseId)).toHaveLength(0);

    updateCaseFacts(caseId, { hasExistingObligations: true }, userId);
    expect(statementRows(caseId).length).toBeGreaterThan(0);

    // And withdrawing the answer withdraws the ask — kept in the history as
    // not_applicable rather than deleted (BR-034).
    updateCaseFacts(caseId, { hasExistingObligations: false }, userId);
    expect(statementRows(caseId)).toHaveLength(0);
    const withdrawn = requirementsOf(caseId).filter((r) => r.status === "not_applicable");
    expect(withdrawn.length).toBeGreaterThan(0);
  });

  it("does not reset what has already been collected when a fact changes", async () => {
    const { caseId, userId } = setup();
    const requirementId = anyPendingRequirementId(caseId);

    await uploadDocument(requirementId, FILE, userId);
    verifyDocument(requirementId, userId);
    expect(requirementsOf(caseId).find((r) => r.id === requirementId)?.status).toBe("verified");

    updateCaseFacts(caseId, { hasExistingObligations: true, isGstRegistered: true }, userId);

    const after = requirementsOf(caseId).find((r) => r.id === requirementId);
    expect(after?.status).toBe("verified");
    expect(after?.satisfiedByDocumentId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Upload → View → Verify
// ---------------------------------------------------------------------------

describe("the document workflow: upload, look at it, then confirm", () => {
  it("moves a requirement from required to uploaded to verified, and no further by itself", async () => {
    const { caseId, userId } = setup();
    const requirementId = anyPendingRequirementId(caseId);

    expect(requirementsOf(caseId).find((r) => r.id === requirementId)?.status).toBe("pending");

    const uploaded = await uploadDocument(requirementId, FILE, userId);
    expect(uploaded.ok).toBe(true);

    // Uploading is NOT verifying. A file that arrived still needs a human.
    const received = requirementsOf(caseId).find((r) => r.id === requirementId);
    expect(received?.status).toBe("received");

    // View: the bytes are readable back out of the storage abstraction, which
    // is what the preview in the verify dialog does before anybody confirms.
    const document = getDb().documents.find((d) => d.id === received?.satisfiedByDocumentId);
    if (!document) throw new Error("expected the upload to have produced a document");
    expect(await storageAdapter.get(document.filePath)).toEqual(FILE.bytes);

    const verified = verifyDocument(requirementId, userId, "PAN readable.");
    expect(verified.ok).toBe(true);

    expect(requirementsOf(caseId).find((r) => r.id === requirementId)?.status).toBe("verified");
    const confirmed = getDb().documents.find((d) => d.id === document.id);
    expect(confirmed?.verifiedBy).toBe(userId);
    expect(confirmed?.verificationNotes).toBe("PAN readable.");
    // A human said what it is. There is no OCR, and the confirmed type is the
    // one a person stood behind.
    expect(confirmed?.confirmedDocumentTypeId).toBe(received?.documentTypeId);
  });

  it("refuses to verify a requirement nothing has been uploaded against", () => {
    const { caseId, userId } = setup();
    const result = verifyDocument(anyPendingRequirementId(caseId), userId);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/uploaded/i);
  });
});

// ---------------------------------------------------------------------------
// 11–12, 14. Documents added by hand, and the catalogue they do not touch
// ---------------------------------------------------------------------------

describe("a document added for one case only", () => {
  it("belongs to that case and appears on no other", () => {
    const first = setup("Kavitha S");
    const secondId = createCase(
      { newApplicantName: "Arun P", loanProductId: first.productId },
      first.userId,
    );

    const result = addCustomRequirement(
      first.caseId,
      {
        category: "additional",
        name: "Bank's NOC for the second charge",
        description: "Letter from the existing bank agreeing to a second charge.",
        applicability: "mandatory",
      },
      first.userId,
    );
    expect(result.ok).toBe(true);

    const onFirst = requirementsOf(first.caseId).filter((r) => r.isCustom);
    expect(onFirst).toHaveLength(1);
    expect(onFirst[0]?.customName).toBe("Bank's NOC for the second charge");
    expect(onFirst[0]?.customCategory).toBe("additional");

    expect(requirementsOf(secondId).filter((r) => r.isCustom)).toHaveLength(0);
  });

  it("changes neither the master catalogue nor the rules behind every other case", () => {
    const { caseId, userId } = setup();
    const typesBefore = JSON.stringify(getDb().documentTypes);
    const rulesBefore = JSON.stringify(getDb().documentRequirementRules);

    addCustomRequirement(
      caseId,
      { category: "income", name: "Existing Loan Statement — HDFC", applicability: "mandatory" },
      userId,
    );

    expect(JSON.stringify(getDb().documentTypes)).toBe(typesBefore);
    expect(JSON.stringify(getDb().documentRequirementRules)).toBe(rulesBefore);
  });

  it("is collected and verified exactly like a generated one", async () => {
    const { caseId, userId } = setup();
    addCustomRequirement(
      caseId,
      { category: "additional", name: "Employer's NOC", applicability: "mandatory" },
      userId,
    );

    const custom = requirementsOf(caseId).find((r) => r.customName === "Employer's NOC");
    if (!custom) throw new Error("expected the custom requirement to have been added");

    await uploadDocument(custom.id, { ...FILE, name: "noc.png" }, userId);
    expect(requirementsOf(caseId).find((r) => r.id === custom.id)?.status).toBe("received");

    verifyDocument(custom.id, userId);
    expect(requirementsOf(caseId).find((r) => r.id === custom.id)?.status).toBe("verified");
  });

  it("seeds the prototype from the one canonical catalogue, with no second list", () => {
    resetDatabase();
    const seeded = getDb().documentTypes;
    const seededCodes = seeded.map((t) => t.code);
    const catalogueCodes = DOCUMENT_CATALOGUE.map((t) => t.code);

    expect(new Set(seededCodes).size).toBe(seededCodes.length);
    for (const code of catalogueCodes) {
      expect(seededCodes).toContain(code);
    }

    // Anything ACTIVE that the catalogue does not define would be a second
    // definition of a document — the thing the consolidation removed. Retired
    // types are the one exception and are retained rather than deleted
    // (BR-027): nothing may ask for them again, so they are not in the
    // catalogue, and they are inactive here.
    for (const type of seeded) {
      if (type.isActive) expect(catalogueCodes).toContain(type.code);
      else expect(catalogueCodes).not.toContain(type.code);
    }
  });
});

// ---------------------------------------------------------------------------
// 13. An incomplete file never reads as a complete one
// ---------------------------------------------------------------------------

describe("a file with mandatory documents outstanding", () => {
  it("is not complete because things were uploaded", async () => {
    const { caseId, userId } = setup();
    openForDocuments(caseId, userId);
    const pending = requirementsOf(caseId).filter((r) => r.status === "pending");
    expect(pending.length).toBeGreaterThan(1);

    for (const requirement of pending) {
      await uploadDocument(requirement.id, FILE, userId);
    }

    const progress = progressFor(caseId);
    expect(progress.receivedCount).toBeGreaterThan(0);
    expect(progress.verifiedCount).toBe(0);
    expect(progress.percentComplete).toBe(0);
    expect(progress.isReadyForSubmission).toBe(false);
    // Uploading everything must not have advanced the case as if it were done.
    expect(caseById(caseId).stage).not.toBe("ready_for_submission");
  });

  it("is not complete while one mandatory document is still missing", async () => {
    const { caseId, userId } = setup();
    openForDocuments(caseId, userId);
    const pending = requirementsOf(caseId).filter((r) => r.status === "pending");

    // Everything but one, verified properly.
    for (const requirement of pending.slice(1)) {
      await uploadDocument(requirement.id, FILE, userId);
      verifyDocument(requirement.id, userId);
    }

    const progress = progressFor(caseId);
    expect(progress.outstandingCount).toBeGreaterThan(0);
    expect(progress.percentComplete).toBeLessThan(100);
    expect(progress.isReadyForSubmission).toBe(false);
  });

  it("counts an optional document as neither missing nor holding the case back", () => {
    const { caseId, userId } = setup();
    openForDocuments(caseId, userId);
    const before = progressFor(caseId);

    addCustomRequirement(
      caseId,
      { category: "additional", name: "Old sanction letter", applicability: "optional" },
      userId,
    );

    const after = progressFor(caseId);
    const optional = requirementsOf(caseId).find((r) => r.customName === "Old sanction letter");

    expect(optional?.applicability).toBe("optional");
    expect(after.optionalCount).toBe(before.optionalCount + 1);
    // It joined the list without joining the arithmetic: nothing that counts
    // toward the case moved, so the percentage did not either.
    expect(after.applicableCount).toBe(before.applicableCount);
    expect(after.percentComplete).toBe(before.percentComplete);
  });
});
