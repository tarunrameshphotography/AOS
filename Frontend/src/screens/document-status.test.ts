import { describe, expect, it } from "vitest";

import { REQUIREMENT_STATUSES, summariseProgress } from "@domain/requirements/index.js";
import type { Requirement } from "@domain/requirements/index.js";

import {
  DOCUMENT_STATES,
  DOCUMENT_STATE_PRESENTATION,
  documentStateCounts,
  documentStateLabel,
  documentStateOf,
  isDocumentCollectionComplete,
} from "./document-status.js";

/**
 * What a requirement is CALLED (Part 8).
 *
 * The distinction being guarded is the one that matters on a phone call:
 * nothing has arrived, something has arrived and nobody has read it, and
 * somebody has read it and confirmed it. Collapsing any two of those is how a
 * case looks finished when it is not.
 */
describe("the words on a requirement row", () => {
  it("has a presentation for every state, and a state for every domain status", () => {
    for (const state of DOCUMENT_STATES) {
      expect(DOCUMENT_STATE_PRESENTATION[state].label.length).toBeGreaterThan(0);
      expect(DOCUMENT_STATE_PRESENTATION[state].meaning.length).toBeGreaterThan(0);
    }
    for (const status of REQUIREMENT_STATUSES) {
      expect(DOCUMENT_STATES).toContain(documentStateOf(status));
    }
  });

  it("distinguishes nothing-arrived from uploaded-but-unread from verified", () => {
    expect(documentStateOf("pending")).toBe("missing");
    expect(documentStateOf("received")).toBe("awaiting_verification");
    expect(documentStateOf("verified")).toBe("verified");

    const labels = [
      documentStateLabel("pending"),
      documentStateLabel("received"),
      documentStateLabel("verified"),
    ];
    expect(new Set(labels).size).toBe(3);
  });

  it("never calls an uploaded-but-unverified document done", () => {
    expect(documentStateLabel("received").toLowerCase()).toContain("awaiting");
  });

  it("says so when a missing document is only optional", () => {
    expect(documentStateOf("pending", "optional")).toBe("optional_missing");
    expect(documentStateLabel("pending", "optional").toLowerCase()).toContain("optional");
  });

  it("reads an unset applicability as mandatory, exactly as progress arithmetic does", () => {
    expect(documentStateOf("pending", undefined)).toBe("missing");
    expect(documentStateOf("pending", "mandatory")).toBe("missing");
  });

  it("keeps waived and no-longer-asked-for apart from verified", () => {
    expect(documentStateOf("waived")).toBe("waived");
    expect(documentStateOf("not_applicable")).toBe("not_applicable");
    expect(documentStateLabel("waived")).not.toBe(documentStateLabel("verified"));
  });

  it("asks for a fresh upload on a rejection rather than reporting it as merely missing", () => {
    expect(documentStateOf("rejected")).toBe("rejected");
    expect(documentStateLabel("rejected").toLowerCase()).toContain("upload");
  });
});

describe("the counts beside the progress bar", () => {
  const requirement = (
    id: string,
    status: Requirement["status"],
    applicability?: "mandatory" | "optional",
  ): Requirement => ({
    id,
    status,
    applicableFromStage: "documents_pending",
    ...(applicability ? { applicability } : {}),
  });

  it("derives every figure from the progress summary, so the strip cannot disagree with the bar", () => {
    const progress = summariseProgress(
      [
        requirement("a", "pending"),
        requirement("b", "received"),
        requirement("c", "verified"),
        requirement("d", "rejected"),
        requirement("e", "waived"),
        requirement("f", "pending", "optional"),
        { id: "g", status: "pending", applicableFromStage: "sanctioned" },
      ],
      "documents_pending",
    );

    const counts = documentStateCounts(progress);

    expect(counts.required).toBe(4); // a, b, c, d — waived and optional excluded
    expect(counts.missing).toBe(1); // a alone: nothing uploaded at all
    expect(counts.awaitingVerification).toBe(1); // b
    expect(counts.verified).toBe(1); // c
    expect(counts.rejected).toBe(1); // d
    expect(counts.waived).toBe(1);
    expect(counts.optional).toBe(1);
    expect(counts.notDueYet).toBe(1);

    // The three that are not verified are exactly what the bar calls outstanding.
    expect(counts.missing + counts.awaitingVerification + counts.rejected).toBe(
      progress.outstandingCount,
    );
  });

  it("does not call a case complete because files were uploaded", () => {
    const progress = summariseProgress(
      [requirement("a", "received"), requirement("b", "received")],
      "documents_pending",
    );

    expect(documentStateCounts(progress).awaitingVerification).toBe(2);
    expect(documentStateCounts(progress).missing).toBe(0);
    expect(progress.percentComplete).toBe(0);
    expect(isDocumentCollectionComplete(progress)).toBe(false);
  });

  it("calls it complete only when everything mandatory has been verified", () => {
    const progress = summariseProgress(
      [requirement("a", "verified"), requirement("b", "pending", "optional")],
      "documents_pending",
    );

    expect(isDocumentCollectionComplete(progress)).toBe(true);
    expect(documentStateCounts(progress).optional).toBe(1);
  });
});
