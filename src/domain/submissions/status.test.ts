import { describe, expect, it } from "vitest";

import { SUBMISSION_STATUSES, canTransitionSubmission, isLiveSubmissionStatus, type SubmissionStatus } from "./index.js";

describe("canTransitionSubmission", () => {
  it("allows the documented happy path", () => {
    expect(canTransitionSubmission("submitted", "under_process")).toBe(true);
    expect(canTransitionSubmission("under_process", "query_raised")).toBe(true);
    expect(canTransitionSubmission("query_raised", "under_process")).toBe(true);
    expect(canTransitionSubmission("under_process", "eligibility_received")).toBe(true);
    expect(canTransitionSubmission("eligibility_received", "sanctioned")).toBe(true);
    expect(canTransitionSubmission("sanctioned", "disbursed")).toBe(true);
  });

  it("allows rejection from every stage of processing, not only after eligibility", () => {
    expect(canTransitionSubmission("submitted", "rejected")).toBe(true);
    expect(canTransitionSubmission("under_process", "rejected")).toBe(true);
    expect(canTransitionSubmission("eligibility_received", "rejected")).toBe(true);
  });

  it("allows withdrawal from any live status, including a never-sent draft", () => {
    for (const status of ["not_submitted", "submitted", "under_process", "eligibility_received", "sanctioned"] as const) {
      expect(canTransitionSubmission(status, "withdrawn")).toBe(true);
    }
  });

  it("refuses withdrawal from query_raised directly — it must resolve back to under_process first", () => {
    expect(canTransitionSubmission("query_raised", "withdrawn")).toBe(false);
  });

  it("refuses skipping steps", () => {
    expect(canTransitionSubmission("submitted", "sanctioned")).toBe(false);
    expect(canTransitionSubmission("submitted", "disbursed")).toBe(false);
    expect(canTransitionSubmission("under_process", "disbursed")).toBe(false);
  });

  it("treats every terminal status as a dead end", () => {
    for (const terminal of ["rejected", "withdrawn", "disbursed"] as const) {
      for (const status of SUBMISSION_STATUSES) {
        expect(canTransitionSubmission(terminal, status)).toBe(false);
      }
    }
  });

  it("refuses moving to the same status", () => {
    for (const status of SUBMISSION_STATUSES) {
      expect(canTransitionSubmission(status, status)).toBe(false);
    }
  });
});

describe("isLiveSubmissionStatus", () => {
  it("is false only for the three terminal outcomes", () => {
    const expectedTerminal: readonly SubmissionStatus[] = ["rejected", "withdrawn", "disbursed"];
    for (const status of SUBMISSION_STATUSES) {
      expect(isLiveSubmissionStatus(status)).toBe(!expectedTerminal.includes(status));
    }
  });
});
