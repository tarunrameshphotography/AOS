/**
 * Operational thresholds — the tunable day-counts.
 *
 * Source of truth: ADR-025
 *
 * AOS has no settings module and no key-value configuration table. This is the
 * one narrow table for timings, and its shape is deliberate: **the keys are a
 * closed enum here, seeded into `operational_threshold` by migration. The value
 * is editable at runtime; the key set is not.**
 *
 * That asymmetry is the whole design. It is the same pattern as the permission
 * catalog (ADR-022), and it is the difference between a lookup table and a
 * configuration system — you cannot add a key without a code change, which is the
 * friction that stops this becoming the place things go when nobody wants to
 * model them properly.
 *
 * If the same kind of constant is being added here repeatedly, that is evidence
 * worth revisiting. A generic table should be the conclusion of that evidence,
 * never its premise.
 */

import { CASE_STAGE_PROGRESSION, type ProgressionStage } from "../case/stages.js";

/**
 * How many days a case may sit in a stage before its health degrades and it
 * appears in "needs attention".
 *
 * Per stage, because the norms are not comparable: three days in `new` is bad,
 * three days in `submitted` is ordinary bank turnaround (`Workflow.md`).
 */
export type IdleThresholdKey = `idle_days.${ProgressionStage}`;

const IDLE_THRESHOLD_KEYS: readonly IdleThresholdKey[] = CASE_STAGE_PROGRESSION.map(
  (stage) => `idle_days.${stage}` as const,
);

/** Thresholds that are not per-stage. */
export const STANDALONE_THRESHOLD_KEYS = [
  /** Days before an offer's `valid_until` at which a task is raised to the case owner. */
  "offer_expiry_warning_days",
  /** How long a document may sit `received` but unverified before it degrades case health. */
  "unverified_document_age_days",
  /** Default follow-up date offered when a case is put on hold (ADR-021). */
  "default_hold_follow_up_days",
] as const;

export type StandaloneThresholdKey = (typeof STANDALONE_THRESHOLD_KEYS)[number];

export type ThresholdKey = IdleThresholdKey | StandaloneThresholdKey;

export const THRESHOLD_KEYS: readonly ThresholdKey[] = [
  ...IDLE_THRESHOLD_KEYS,
  ...STANDALONE_THRESHOLD_KEYS,
];

/**
 * Seeded values, in days.
 *
 * These are **starting points, not findings.** Nobody has measured Amaze's actual
 * turnaround yet, and a number invented in a design session should be easy to
 * correct — which is precisely why the value is data and the key is not. Expect
 * every one of these to move once there is a quarter of history.
 *
 * The stage-idle values follow the shape of the work rather than a single
 * constant: early stages are the company's own responsiveness and should be
 * short; later stages are waiting on a bank and should not generate noise.
 */
export const THRESHOLD_DEFAULTS: Record<ThresholdKey, number> = {
  "idle_days.new": 1,
  "idle_days.contacted": 3,
  "idle_days.appointment_fixed": 2,
  "idle_days.documents_pending": 5,
  "idle_days.ready_for_submission": 2,
  "idle_days.submitted": 10,
  "idle_days.sanctioned": 7,
  "idle_days.disbursed": 14,

  offer_expiry_warning_days: 7,
  unverified_document_age_days: 3,
  default_hold_follow_up_days: 14,
};

export function idleThresholdKey(stage: ProgressionStage): IdleThresholdKey {
  return `idle_days.${stage}`;
}

export function isThresholdKey(value: string): value is ThresholdKey {
  return (THRESHOLD_KEYS as readonly string[]).includes(value);
}
