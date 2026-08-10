import { describe, expect, it } from "vitest";
import type { CaseStage } from "./stages.js";
import {
  type CaseSnapshot,
  deriveSystemStage,
  deriveSystemStagePath,
  evaluateTransition,
  userSelectableStages,
} from "./transitions.js";

function snapshot(overrides: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return {
    stage: "new",
    outstandingRequirementCount: 0,
    liveSubmissionCount: 0,
    hasSanctionedSubmissionWithOffer: false,
    hasDisbursedSubmission: false,
    isInvoiceRaised: false,
    stageBeforeLost: null,
    ...overrides,
  };
}

describe("evaluateTransition", () => {
  describe("the normal path", () => {
    it("allows new → contacted on first contact", () => {
      const outcome = evaluateTransition(snapshot({ stage: "new" }), {
        to: "contacted",
        actor: "user",
      });

      expect(outcome.allowed).toBe(true);
    });

    it("allows an appointment to be cancelled back to contacted", () => {
      const outcome = evaluateTransition(snapshot({ stage: "appointment_fixed" }), {
        to: "contacted",
        actor: "user",
      });

      expect(outcome.allowed).toBe(true);
    });
  });

  describe("invalid moves", () => {
    it("refuses a jump from new straight to sanctioned", () => {
      const outcome = evaluateTransition(snapshot({ stage: "new" }), {
        to: "sanctioned",
        actor: "system",
      });

      expect(outcome).toMatchObject({ allowed: false });
    });

    it("refuses a move to the stage the case is already in", () => {
      const outcome = evaluateTransition(snapshot({ stage: "contacted" }), {
        to: "contacted",
        actor: "user",
      });

      expect(outcome).toMatchObject({ allowed: false });
    });

    it("refuses to move a closed case — closed is terminal", () => {
      const outcome = evaluateTransition(snapshot({ stage: "closed" }), {
        to: "disbursed",
        actor: "user",
      });

      expect(outcome).toMatchObject({ allowed: false });
    });

    it("explains every refusal, so the user is never left at a dead end", () => {
      const outcome = evaluateTransition(snapshot({ stage: "new" }), {
        to: "disbursed",
        actor: "system",
      });

      expect(outcome.allowed).toBe(false);
      if (!outcome.allowed) {
        expect(outcome.reason.length).toBeGreaterThan(0);
      }
    });
  });

  describe("guards", () => {
    it("blocks ready_for_submission while requirements are outstanding", () => {
      const outcome = evaluateTransition(
        snapshot({ stage: "documents_pending", outstandingRequirementCount: 3 }),
        { to: "ready_for_submission", actor: "system" },
      );

      expect(outcome).toMatchObject({ allowed: false });
      if (!outcome.allowed) {
        expect(outcome.reason).toContain("3 requirement");
      }
    });

    it("allows ready_for_submission once nothing is outstanding", () => {
      const outcome = evaluateTransition(
        snapshot({ stage: "documents_pending", outstandingRequirementCount: 0 }),
        { to: "ready_for_submission", actor: "system" },
      );

      expect(outcome.allowed).toBe(true);
    });

    it("refuses to advance to sanctioned without an offer attached (BR-023)", () => {
      const outcome = evaluateTransition(
        snapshot({
          stage: "submitted",
          liveSubmissionCount: 2,
          hasSanctionedSubmissionWithOffer: false,
        }),
        { to: "sanctioned", actor: "system" },
      );

      expect(outcome).toMatchObject({ allowed: false });
    });

    it("refuses to close a case before the invoice is raised", () => {
      const outcome = evaluateTransition(
        snapshot({ stage: "disbursed", hasDisbursedSubmission: true, isInvoiceRaised: false }),
        { to: "closed", actor: "user" },
      );

      expect(outcome).toMatchObject({ allowed: false });
    });
  });

  describe("the backwards transition (ADR-010)", () => {
    it("returns a ready case to documents_pending when a new requirement appears", () => {
      const outcome = evaluateTransition(
        snapshot({ stage: "ready_for_submission", outstandingRequirementCount: 4 }),
        { to: "documents_pending", actor: "system" },
      );

      expect(outcome.allowed).toBe(true);
    });

    it("does not send a case backwards while nothing is outstanding", () => {
      const outcome = evaluateTransition(
        snapshot({ stage: "ready_for_submission", outstandingRequirementCount: 0 }),
        { to: "documents_pending", actor: "system" },
      );

      expect(outcome).toMatchObject({ allowed: false });
    });
  });

  describe("actor rules", () => {
    it("refuses a system transition requested by a user", () => {
      const outcome = evaluateTransition(
        snapshot({ stage: "documents_pending", outstandingRequirementCount: 0 }),
        { to: "ready_for_submission", actor: "user" },
      );

      expect(outcome).toMatchObject({ allowed: false });
    });

    it("refuses a user transition requested by the system", () => {
      const outcome = evaluateTransition(snapshot({ stage: "new" }), {
        to: "contacted",
        actor: "system",
      });

      expect(outcome).toMatchObject({ allowed: false });
    });
  });

  describe("loss", () => {
    const nonTerminalStages: CaseStage[] = [
      "new",
      "contacted",
      "appointment_fixed",
      "documents_pending",
      "ready_for_submission",
      "submitted",
      "sanctioned",
      "disbursed",
    ];

    it.each(nonTerminalStages)("can be reached from %s", (stage) => {
      const outcome = evaluateTransition(snapshot({ stage }), {
        to: "lost",
        actor: "user",
        lostReason: "not_interested",
      });

      expect(outcome.allowed).toBe(true);
    });

    it("can be reached from sanctioned — customers do walk away over rate", () => {
      const outcome = evaluateTransition(
        snapshot({ stage: "sanctioned", hasSanctionedSubmissionWithOffer: true }),
        { to: "lost", actor: "user", lostReason: "rate_too_high" },
      );

      expect(outcome.allowed).toBe(true);
    });

    it("requires a reason", () => {
      const outcome = evaluateTransition(snapshot({ stage: "contacted" }), {
        to: "lost",
        actor: "user",
      });

      expect(outcome).toMatchObject({ allowed: false });
    });

    it("is never decided by the system", () => {
      const outcome = evaluateTransition(snapshot({ stage: "contacted" }), {
        to: "lost",
        actor: "system",
        lostReason: "unreachable",
      });

      expect(outcome).toMatchObject({ allowed: false });
    });

    it("cannot be applied to an already-closed case", () => {
      const outcome = evaluateTransition(snapshot({ stage: "closed" }), {
        to: "lost",
        actor: "user",
        lostReason: "not_interested",
      });

      expect(outcome).toMatchObject({ allowed: false });
    });
  });

  describe("reopening", () => {
    it("restores the stage the case was lost from", () => {
      const outcome = evaluateTransition(
        snapshot({ stage: "lost", stageBeforeLost: "documents_pending" }),
        { to: "documents_pending", actor: "user" },
      );

      expect(outcome.allowed).toBe(true);
    });

    it("refuses to reopen into some other stage", () => {
      const outcome = evaluateTransition(
        snapshot({ stage: "lost", stageBeforeLost: "documents_pending" }),
        { to: "sanctioned", actor: "user" },
      );

      expect(outcome).toMatchObject({ allowed: false });
    });

    it("refuses when the prior stage is unknown", () => {
      const outcome = evaluateTransition(snapshot({ stage: "lost", stageBeforeLost: null }), {
        to: "contacted",
        actor: "user",
      });

      expect(outcome).toMatchObject({ allowed: false });
    });
  });
});

describe("deriveSystemStage (ADR-019)", () => {
  it("advances a ready case to submitted once a file goes to a bank", () => {
    const next = deriveSystemStage(
      snapshot({ stage: "ready_for_submission", liveSubmissionCount: 1 }),
    );

    expect(next).toBe("submitted");
  });

  it("advances to sanctioned when a sanction has an offer attached", () => {
    const next = deriveSystemStage(
      snapshot({
        stage: "submitted",
        liveSubmissionCount: 3,
        hasSanctionedSubmissionWithOffer: true,
      }),
    );

    expect(next).toBe("sanctioned");
  });

  it("returns null when the case is already where it should be", () => {
    const next = deriveSystemStage(
      snapshot({ stage: "submitted", liveSubmissionCount: 2 }),
    );

    expect(next).toBeNull();
  });

  it("never moves a case backwards — a rejection at one bank is not a reversal", () => {
    // Sanctioned at one bank, then a second bank rejects. Submissions remain
    // live, but the case has already reached sanctioned and stays there.
    const next = deriveSystemStage(
      snapshot({
        stage: "sanctioned",
        liveSubmissionCount: 5,
        hasSanctionedSubmissionWithOffer: true,
      }),
    );

    expect(next).toBeNull();
  });

  it("does nothing for a case with no submissions", () => {
    expect(deriveSystemStage(snapshot({ stage: "documents_pending" }))).toBeNull();
  });
});

/**
 * Regression tests for the stranding bug: `deriveSystemStage` picked the highest
 * applicable stage and then asked whether the case could move there *directly*.
 * When two submission changes landed between evaluations, the answer was no, and
 * the case stopped advancing permanently — nothing threw, the stage was simply
 * wrong on cases where money had already moved.
 *
 * Same class as ADR-023: a plausible-looking wrong answer that fails silently.
 */
describe("deriveSystemStagePath — advancing more than one stage", () => {
  it("steps a submitted case to sanctioned when a submission is already disbursed", () => {
    const path = deriveSystemStagePath(
      snapshot({
        stage: "submitted",
        liveSubmissionCount: 1,
        hasSanctionedSubmissionWithOffer: true,
        hasDisbursedSubmission: true,
      }),
    );

    expect(path).toEqual(["sanctioned", "disbursed"]);
  });

  it("returns the first step from deriveSystemStage rather than stranding the case", () => {
    const next = deriveSystemStage(
      snapshot({
        stage: "submitted",
        liveSubmissionCount: 1,
        hasSanctionedSubmissionWithOffer: true,
        hasDisbursedSubmission: true,
      }),
    );

    expect(next).toBe("sanctioned");
  });

  it("walks the whole run when a ready case is disbursed before anyone looked", () => {
    const path = deriveSystemStagePath(
      snapshot({
        stage: "ready_for_submission",
        liveSubmissionCount: 2,
        hasSanctionedSubmissionWithOffer: true,
        hasDisbursedSubmission: true,
      }),
    );

    expect(path).toEqual(["submitted", "sanctioned", "disbursed"]);
  });

  it("stops at the stage whose guard refuses rather than skipping it", () => {
    // Disbursed is claimed, but no sanction has an offer attached. BR-023 says
    // the case cannot pass through sanctioned, so it must not arrive at
    // disbursed either.
    const path = deriveSystemStagePath(
      snapshot({
        stage: "submitted",
        liveSubmissionCount: 1,
        hasSanctionedSubmissionWithOffer: false,
        hasDisbursedSubmission: true,
      }),
    );

    expect(path).toEqual([]);
  });

  it("never auto-advances a lost case, whatever its submissions say", () => {
    const path = deriveSystemStagePath(
      snapshot({
        stage: "lost",
        stageBeforeLost: "submitted",
        liveSubmissionCount: 1,
        hasSanctionedSubmissionWithOffer: true,
        hasDisbursedSubmission: true,
      }),
    );

    expect(path).toEqual([]);
  });

  it("never auto-advances a closed case", () => {
    const path = deriveSystemStagePath(
      snapshot({ stage: "closed", liveSubmissionCount: 1, hasDisbursedSubmission: true }),
    );

    expect(path).toEqual([]);
  });

  it("does not walk backwards when the justified stage is lower than the current one", () => {
    // Every submission withdrawn after sanction. `liveSubmissionCount` drops,
    // but the bank did sanction and the case stays where it got to.
    const path = deriveSystemStagePath(
      snapshot({ stage: "sanctioned", liveSubmissionCount: 0 }),
    );

    expect(path).toEqual([]);
  });
});

describe("userSelectableStages", () => {
  it("never offers a stage reached only by a system transition", () => {
    // ready_for_submission, submitted, sanctioned and disbursed are each only
    // reachable via a system-actor rule — the Move stage UI must not offer
    // them, or the user hits "X → Y is a system transition" for a move the
    // dropdown itself suggested.
    for (const stage of ["ready_for_submission", "submitted", "sanctioned", "disbursed"] as const) {
      expect(userSelectableStages(stage)).not.toContain(stage);
    }
  });

  it("offers nothing from documents_pending — it only advances on its own", () => {
    expect(userSelectableStages("documents_pending")).toEqual([]);
  });

  it("offers nothing from ready_for_submission — submission and reversion are both automatic", () => {
    expect(userSelectableStages("ready_for_submission")).toEqual([]);
  });

  it("offers nothing from submitted or sanctioned — both only advance automatically", () => {
    expect(userSelectableStages("submitted")).toEqual([]);
    expect(userSelectableStages("sanctioned")).toEqual([]);
  });

  it("still offers the legitimate manual moves", () => {
    expect(userSelectableStages("new")).toEqual(["contacted"]);
    expect(userSelectableStages("contacted")).toEqual(["appointment_fixed", "documents_pending"]);
    expect(userSelectableStages("appointment_fixed")).toEqual(["documents_pending", "contacted"]);
    expect(userSelectableStages("disbursed")).toEqual(["closed"]);
  });
});
