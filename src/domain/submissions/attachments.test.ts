import { describe, expect, it } from "vitest";

import {
  GMAIL_MAX_MESSAGE_BYTES,
  MAX_ATTACHMENT_BYTES_PER_EMAIL,
  MIME_OVERHEAD_BYTES,
  base64EncodedSize,
  describeIneligibility,
  fitsProviderMessageLimit,
  ineligibility,
  isSendable,
  type CandidateDocument,
} from "./attachments.js";

const MB = 1024 * 1024;

function document(overrides: Partial<CandidateDocument> = {}): CandidateDocument {
  return {
    documentId: "doc_1",
    documentTypeCode: "pan_card",
    label: "PAN Card",
    fileName: "pan.pdf",
    fileSizeBytes: 200_000,
    category: "kyc",
    version: 1,
    verifiedAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("eligibility — only a verified document goes to a bank", () => {
  it("accepts a verified document", () => {
    expect(isSendable(document())).toBe(true);
    expect(ineligibility(document())).toBeUndefined();
  });

  it("refuses a document nobody has verified", () => {
    const reason = ineligibility(document({ verifiedAt: undefined }));
    expect(reason).toEqual({ kind: "not_verified" });
    expect(describeIneligibility(reason!)).toContain("Not verified");
  });

  it("refuses a rejected document even when it also carries a verification stamp", () => {
    // The pathological ordering: a document verified, then rejected on a
    // second look. Rejection has to win, or a re-reviewed document goes to a
    // bank because the older stamp is still on the row.
    const reason = ineligibility(
      document({ verifiedAt: "2026-08-01T10:00:00.000Z", rejectedAt: "2026-08-02T10:00:00.000Z" }),
    );
    expect(reason).toEqual({ kind: "rejected" });
  });

  it("refuses a rejected document ahead of complaining about its size", () => {
    // Telling somebody their rejected file is too large invites them to
    // shrink it and try again, which will not work.
    const reason = ineligibility(
      document({ rejectedAt: "2026-08-02T10:00:00.000Z", fileSizeBytes: 40 * MB }),
    );
    expect(reason?.kind).toBe("rejected");
  });

  it("refuses a single file larger than one whole email, and names a next action", () => {
    const reason = ineligibility(document({ fileSizeBytes: 12 * MB }));
    expect(reason).toEqual({
      kind: "too_large",
      fileSizeBytes: 12 * MB,
      limitBytes: MAX_ATTACHMENT_BYTES_PER_EMAIL,
    });

    const sentence = describeIneligibility(reason!);
    expect(sentence).toContain("12.0 MB");
    expect(sentence).toContain("10.0 MB");
    // The rule this milestone states outright: never silently compress.
    expect(sentence).toMatch(/smaller scan|split/i);
    expect(sentence).toContain("will not shrink it");
  });

  it("accepts a file exactly at the limit — the ceiling is inclusive", () => {
    expect(isSendable(document({ fileSizeBytes: MAX_ATTACHMENT_BYTES_PER_EMAIL }))).toBe(true);
    expect(isSendable(document({ fileSizeBytes: MAX_ATTACHMENT_BYTES_PER_EMAIL + 1 }))).toBe(false);
  });
});

describe("the size ceiling is provably below the provider's", () => {
  it("is ten binary megabytes, matching how a file size is rendered on screen", () => {
    expect(MAX_ATTACHMENT_BYTES_PER_EMAIL).toBe(10 * 1024 * 1024);
  });

  it("expands by roughly four thirds under base64, plus line wrapping", () => {
    // 3 raw bytes -> 4 characters, no wrap needed at that size.
    expect(base64EncodedSize(3)).toBe(4 + 2);
    // A megabyte: 4/3 plus a CRLF every 76 characters.
    const encoded = base64EncodedSize(MB);
    expect(encoded).toBeGreaterThan((MB * 4) / 3);
    expect(encoded).toBeLessThan(MB * 1.38);
  });

  it("leaves a full email comfortably inside Gmail's 25 MB message limit", () => {
    // THE ASSERTION THAT MAKES "10 MB IS SAFE" A CHECKED CLAIM. If anybody
    // ever raises MAX_ATTACHMENT_BYTES_PER_EMAIL, this is what tells them
    // whether they may.
    const worstCase = base64EncodedSize(MAX_ATTACHMENT_BYTES_PER_EMAIL) + MIME_OVERHEAD_BYTES;
    expect(worstCase).toBeLessThan(GMAIL_MAX_MESSAGE_BYTES);
    expect(fitsProviderMessageLimit(MAX_ATTACHMENT_BYTES_PER_EMAIL)).toBe(true);

    // And it is not a marginal pass — there is better than 10 MB of headroom,
    // which is what makes a provider rejection on size effectively impossible.
    expect(GMAIL_MAX_MESSAGE_BYTES - worstCase).toBeGreaterThan(10 * MB);
  });

  it("would refuse a hypothetical provider whose own limit is smaller", () => {
    // Not reachable with Gmail; the parameter exists so a future provider
    // brings its own number rather than inheriting an assumption.
    expect(fitsProviderMessageLimit(MAX_ATTACHMENT_BYTES_PER_EMAIL, 5 * MB)).toBe(false);
  });
});
