import { describe, expect, it } from "vitest";
import { type Requirement, summariseProgress } from "./progress.js";

let nextRequirementId = 0;

function requirement(overrides: Partial<Requirement> = {}): Requirement {
  nextRequirementId += 1;
  return {
    id: `req-${nextRequirementId}`,
    status: "pending",
    applicableFromStage: "new",
    ...overrides,
  };
}

describe("summariseProgress", () => {
  describe("the simple-case guarantee (ADR-011)", () => {
    it("reaches 100% for one applicant with everything verified", () => {
      const summary = summariseProgress(
        [
          requirement({ status: "verified" }),
          requirement({ status: "verified" }),
          requirement({ status: "verified" }),
        ],
        "new",
      );

      expect(summary.percentComplete).toBe(100);
      expect(summary.isReadyForSubmission).toBe(true);
    });

    it("treats a case with no applicable requirements as complete, not as zero", () => {
      const summary = summariseProgress([], "new");

      expect(summary.percentComplete).toBe(100);
      expect(summary.isReadyForSubmission).toBe(true);
    });
  });

  describe("exclusions from the denominator (BR-034)", () => {
    it("ignores waived requirements entirely", () => {
      const summary = summariseProgress(
        [requirement({ status: "verified" }), requirement({ status: "waived" })],
        "new",
      );

      expect(summary.applicableCount).toBe(1);
      expect(summary.waivedCount).toBe(1);
      expect(summary.percentComplete).toBe(100);
    });

    it("ignores not_applicable requirements entirely", () => {
      const summary = summariseProgress(
        [requirement({ status: "verified" }), requirement({ status: "not_applicable" })],
        "new",
      );

      expect(summary.applicableCount).toBe(1);
      expect(summary.notApplicableCount).toBe(1);
      expect(summary.percentComplete).toBe(100);
    });

    it("cannot be dragged below 100% by any number of excluded requirements", () => {
      const summary = summariseProgress(
        [
          requirement({ status: "verified" }),
          ...Array.from({ length: 20 }, () => requirement({ status: "not_applicable" })),
          ...Array.from({ length: 20 }, () => requirement({ status: "waived" })),
        ],
        "new",
      );

      expect(summary.percentComplete).toBe(100);
    });
  });

  describe("partial progress", () => {
    it("counts only verified requirements toward the score", () => {
      const summary = summariseProgress(
        [
          requirement({ status: "verified" }),
          requirement({ status: "received" }),
          requirement({ status: "pending" }),
          requirement({ status: "pending" }),
        ],
        "new",
      );

      expect(summary.percentComplete).toBe(25);
      expect(summary.receivedCount).toBe(1);
      expect(summary.outstandingCount).toBe(3);
      expect(summary.isReadyForSubmission).toBe(false);
    });

    it("does not treat received-but-unverified as done — a human must check (BR-032)", () => {
      const summary = summariseProgress(
        [requirement({ status: "received" }), requirement({ status: "received" })],
        "new",
      );

      expect(summary.percentComplete).toBe(0);
      expect(summary.isReadyForSubmission).toBe(false);
    });
  });

  describe("stage applicability", () => {
    it("excludes requirements not yet due, counting them as upcoming", () => {
      const summary = summariseProgress(
        [
          requirement({ status: "verified", applicableFromStage: "new" }),
          requirement({ status: "pending", applicableFromStage: "submitted" }),
        ],
        "new",
      );

      expect(summary.applicableCount).toBe(1);
      expect(summary.upcomingCount).toBe(1);
      expect(summary.percentComplete).toBe(100);
      expect(summary.isReadyForSubmission).toBe(true);
    });

    it("pulls a requirement in once the case reaches its stage", () => {
      const requirements = [
        requirement({ status: "verified", applicableFromStage: "new" }),
        requirement({ status: "pending", applicableFromStage: "submitted" }),
      ];

      expect(summariseProgress(requirements, "submitted").applicableCount).toBe(2);
      expect(summariseProgress(requirements, "submitted").percentComplete).toBe(50);
    });
  });

  describe("terminal stages (ADR-023)", () => {
    // Regression: stage position was previously passed as a raw array index,
    // which put `lost` at the highest ordinal and made every requirement —
    // including ones due only near disbursement — appear due on a dead case.
    it("reports nothing outstanding on a lost case", () => {
      const summary = summariseProgress(
        [
          requirement({ status: "pending", applicableFromStage: "new" }),
          requirement({ status: "pending", applicableFromStage: "disbursed" }),
        ],
        "lost",
      );

      expect(summary.applicableCount).toBe(0);
      expect(summary.outstandingCount).toBe(0);
    });

    it("does not treat a late-stage requirement as due on a lost case", () => {
      const summary = summariseProgress(
        [requirement({ status: "pending", applicableFromStage: "disbursed" })],
        "lost",
      );

      expect(summary.upcomingCount).toBe(1);
      expect(summary.outstandingCount).toBe(0);
    });

    it("reports nothing outstanding on a closed case", () => {
      const summary = summariseProgress(
        [requirement({ status: "pending", applicableFromStage: "new" })],
        "closed",
      );

      expect(summary.outstandingCount).toBe(0);
    });
  });

  describe("adding a participant mid-case", () => {
    it("moves progress backwards honestly rather than flattering the user", () => {
      const before = summariseProgress([requirement({ status: "verified" })], "new");
      expect(before.percentComplete).toBe(100);

      // A co-applicant is added in week three, bringing four new requirements.
      const after = summariseProgress(
        [
          requirement({ status: "verified" }),
          requirement({ status: "pending" }),
          requirement({ status: "pending" }),
          requirement({ status: "pending" }),
          requirement({ status: "pending" }),
        ],
        "new",
      );

      expect(after.percentComplete).toBe(20);
      expect(after.isReadyForSubmission).toBe(false);
    });
  });
});
