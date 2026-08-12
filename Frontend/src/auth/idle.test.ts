import { describe, expect, it } from "vitest";

import { computeIdleState, IDLE_TIMEOUT_MS, IDLE_WARNING_LEAD_MS } from "./idle.js";

describe("computeIdleState — the client-side clock behind the idle warning", () => {
  it("shows nothing while comfortably inside the idle window", () => {
    const lastActivityAt = 0;
    const now = IDLE_TIMEOUT_MS - IDLE_WARNING_LEAD_MS - 1;
    expect(computeIdleState(lastActivityAt, now)).toEqual({
      expired: false,
      warningSecondsLeft: null,
    });
  });

  it("starts counting down the moment the warning window is entered", () => {
    const lastActivityAt = 0;
    const now = IDLE_TIMEOUT_MS - IDLE_WARNING_LEAD_MS;
    const state = computeIdleState(lastActivityAt, now);
    expect(state.expired).toBe(false);
    expect(state.warningSecondsLeft).toBe(Math.ceil(IDLE_WARNING_LEAD_MS / 1000));
  });

  it("counts down to a small number of seconds just before expiry", () => {
    const lastActivityAt = 0;
    const now = IDLE_TIMEOUT_MS - 3_500;
    expect(computeIdleState(lastActivityAt, now).warningSecondsLeft).toBe(4);
  });

  it("reports expired the instant the timeout is reached, with no countdown", () => {
    const lastActivityAt = 0;
    expect(computeIdleState(lastActivityAt, IDLE_TIMEOUT_MS)).toEqual({
      expired: true,
      warningSecondsLeft: null,
    });
  });

  it("stays expired arbitrarily far past the timeout", () => {
    const lastActivityAt = 0;
    expect(computeIdleState(lastActivityAt, IDLE_TIMEOUT_MS + 10 * 60 * 1000)).toEqual({
      expired: true,
      warningSecondsLeft: null,
    });
  });

  it("resetting lastActivityAt dismisses the warning, mirroring 'Continue session'", () => {
    // Deep in the warning window...
    const deepIn = computeIdleState(0, IDLE_TIMEOUT_MS - 5_000);
    expect(deepIn.warningSecondsLeft).not.toBeNull();

    // ...but activity moves the reference point forward, exactly as a
    // successful `/auth/me` ping does via `noteActivity()` in client.ts.
    const afterContinue = computeIdleState(IDLE_TIMEOUT_MS - 5_000, IDLE_TIMEOUT_MS - 5_000);
    expect(afterContinue).toEqual({ expired: false, warningSecondsLeft: null });
  });

  it("honours custom timeout/lead values rather than only the exported defaults", () => {
    expect(computeIdleState(0, 4_000, 5_000, 2_000)).toEqual({
      expired: false,
      warningSecondsLeft: 1,
    });
    expect(computeIdleState(0, 5_000, 5_000, 2_000)).toEqual({
      expired: true,
      warningSecondsLeft: null,
    });
  });
});
