import { describe, expect, it } from "vitest";

import { CASE_STAGE_PROGRESSION, TERMINAL_STAGES } from "../case/stages.js";
import {
  THRESHOLD_DEFAULTS,
  THRESHOLD_KEYS,
  idleThresholdKey,
  isThresholdKey,
} from "./thresholds.js";

describe("threshold keys", () => {
  it("covers every progression stage, so no stage silently has no idle norm", () => {
    for (const stage of CASE_STAGE_PROGRESSION) {
      expect(THRESHOLD_KEYS).toContain(idleThresholdKey(stage));
    }
  });

  it("has no idle threshold for a terminal stage — a lost case is not stale, it is over", () => {
    for (const stage of TERMINAL_STAGES) {
      expect(THRESHOLD_KEYS).not.toContain(`idle_days.${stage}`);
    }
  });

  it("gives every key a default, because a seeded row with no value is a null nobody handles", () => {
    for (const key of THRESHOLD_KEYS) {
      expect(THRESHOLD_DEFAULTS[key], `${key} has no default`).toBeDefined();
      expect(Number.isInteger(THRESHOLD_DEFAULTS[key])).toBe(true);
      expect(THRESHOLD_DEFAULTS[key]).toBeGreaterThan(0);
    }
  });

  it("defines no default for a key that is not in the closed set", () => {
    for (const key of Object.keys(THRESHOLD_DEFAULTS)) {
      expect(isThresholdKey(key), `${key} has a default but is not a key`).toBe(true);
    }
  });

  it("has no duplicate keys", () => {
    expect(new Set(THRESHOLD_KEYS).size).toBe(THRESHOLD_KEYS.length);
  });

  it("rejects a key that is not in the closed set — the point of the shape (ADR-025)", () => {
    expect(isThresholdKey("idle_days.lost")).toBe(false);
    expect(isThresholdKey("smtp_host")).toBe(false);
  });
});
