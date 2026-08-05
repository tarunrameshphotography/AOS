import { describe, expect, it } from "vitest";
import { nextVersion, versionHistory } from "./versioning.js";

describe("nextVersion", () => {
  it("starts a first upload at 1", () => {
    expect(nextVersion()).toBe(1);
  });

  it("increments from the previous version", () => {
    expect(nextVersion({ version: 1 })).toBe(2);
    expect(nextVersion({ version: 4 })).toBe(5);
  });
});

describe("versionHistory", () => {
  const documents = [
    { id: "doc-1" },
    { id: "doc-2", supersedesDocumentId: "doc-1" },
    { id: "doc-3", supersedesDocumentId: "doc-2" },
  ];

  it("walks the supersedes chain from latest to first", () => {
    expect(versionHistory(documents, "doc-3")).toEqual(["doc-3", "doc-2", "doc-1"]);
  });

  it("returns a single entry for a document with no earlier version", () => {
    expect(versionHistory(documents, "doc-1")).toEqual(["doc-1"]);
  });

  it("stops at an unknown id rather than throwing", () => {
    expect(versionHistory(documents, "doc-missing")).toEqual([]);
  });

  it("does not loop forever on a cyclic supersedes chain", () => {
    const cyclic = [
      { id: "a", supersedesDocumentId: "b" },
      { id: "b", supersedesDocumentId: "a" },
    ];
    expect(versionHistory(cyclic, "a")).toEqual(["a", "b"]);
  });
});
