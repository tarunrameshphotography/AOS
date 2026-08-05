import { describe, expect, it } from "vitest";
import { buildStoragePath, resolveDocumentOwner } from "./path.js";

describe("resolveDocumentOwner", () => {
  it("resolves each owner kind from the four-optional-field shape", () => {
    expect(resolveDocumentOwner({ ownerKind: "person", personId: "per-1" })).toEqual({
      kind: "person",
      id: "per-1",
    });
    expect(resolveDocumentOwner({ ownerKind: "property", propertyId: "prp-1" })).toEqual({
      kind: "property",
      id: "prp-1",
    });
    expect(
      resolveDocumentOwner({ ownerKind: "organisation", organisationId: "org-1" }),
    ).toEqual({ kind: "organisation", id: "org-1" });
    expect(resolveDocumentOwner({ ownerKind: "case", caseId: "cas-1" })).toEqual({
      kind: "case",
      id: "cas-1",
    });
  });

  it("throws when ownerKind names a field that is not set", () => {
    expect(() => resolveDocumentOwner({ ownerKind: "person" })).toThrow(/BR-030/);
    expect(() =>
      resolveDocumentOwner({ ownerKind: "person", organisationId: "org-1" }),
    ).toThrow();
  });
});

describe("buildStoragePath", () => {
  it("lays out person-owned documents by owner then type then version", () => {
    const path = buildStoragePath({
      owner: { kind: "person", id: "per-1" },
      documentTypeCode: "pan",
      version: 1,
      fileName: "ravi-pan.pdf",
    });
    expect(path).toBe("person/per-1/pan/v1-ravi-pan.pdf");
  });

  it("folds a period into a financial-year segment", () => {
    const path = buildStoragePath({
      owner: { kind: "organisation", id: "org-22" },
      documentTypeCode: "gst_returns",
      version: 1,
      periodStart: "2024-04-01",
      fileName: "gstr-3b-q1.pdf",
    });
    expect(path).toBe("organisation/org-22/gst_returns/2024_25/v1-gstr-3b-q1.pdf");
  });

  it("increments the version segment without touching the rest of the path", () => {
    const base = {
      owner: { kind: "property" as const, id: "prp-1" },
      documentTypeCode: "sale_deed",
      fileName: "sale-deed.pdf",
    };
    expect(buildStoragePath({ ...base, version: 1 })).toBe(
      "property/prp-1/sale_deed/v1-sale-deed.pdf",
    );
    expect(buildStoragePath({ ...base, version: 2 })).toBe(
      "property/prp-1/sale_deed/v2-sale-deed.pdf",
    );
  });

  it("supports case-owned documents", () => {
    const path = buildStoragePath({
      owner: { kind: "case", id: "cas-1" },
      documentTypeCode: "sanction_letter",
      version: 1,
      fileName: "sanction.pdf",
    });
    expect(path).toBe("case/cas-1/sanction_letter/v1-sanction.pdf");
  });

  it("sanitizes unsafe characters in the original file name", () => {
    const path = buildStoragePath({
      owner: { kind: "person", id: "per-1" },
      documentTypeCode: "address_proof",
      version: 1,
      fileName: "EB Bill (June) — scan #2.pdf",
    });
    expect(path).toBe("person/per-1/address_proof/v1-EB_Bill_June_scan_2.pdf");
  });

  it("falls back to a placeholder name when nothing safe survives sanitization", () => {
    const path = buildStoragePath({
      owner: { kind: "person", id: "per-1" },
      documentTypeCode: "pan",
      version: 1,
      fileName: "★★★",
    });
    expect(path).toBe("person/per-1/pan/v1-file");
  });

  it("rejects a non-positive or fractional version", () => {
    const base = {
      owner: { kind: "person" as const, id: "per-1" },
      documentTypeCode: "pan",
      fileName: "pan.pdf",
    };
    expect(() => buildStoragePath({ ...base, version: 0 })).toThrow();
    expect(() => buildStoragePath({ ...base, version: 1.5 })).toThrow();
  });
});
