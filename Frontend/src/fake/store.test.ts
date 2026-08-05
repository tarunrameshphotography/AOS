import { describe, expect, it } from "vitest";

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

const { getDb, resetDatabase, uploadDocument } = await import("./store.js");
const { storageAdapter } = await import("./storage.js");

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
