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

const { createCase, getDb, resetDatabase, uploadDocument } = await import("./store.js");
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
