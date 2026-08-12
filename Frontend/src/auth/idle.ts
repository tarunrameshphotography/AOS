/**
 * Pure timing logic behind the idle-session warning — split out from
 * `IdleSessionMonitor.tsx` so it can be unit tested without a DOM.
 *
 * Mirrors the server's rule (`SESSION_IDLE_MS`, Backend/api-server.ts): the
 * clock is "now minus the last authenticated activity", not a countdown timer
 * of its own, so the frontend's idea of "how long left" agrees with the
 * server's whether or not this tab has been open the whole time. The two
 * defaults below must match `AOS_SESSION_IDLE_MS`'s default there — see that
 * file's comment on `SESSION_IDLE_MS`.
 */

/** Must match `Backend/api-server.ts`'s `SESSION_IDLE_MS` default. */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** How long before expiry the warning appears. Long enough to read the
 * message and click "Continue session" without feeling rushed, short enough
 * that it is unmistakably a last call rather than an early nag. */
export const IDLE_WARNING_LEAD_MS = 60 * 1000;

export interface IdleState {
  /** The idle window has fully elapsed — the server will already be
   * refusing this token. */
  readonly expired: boolean;
  /** Whole seconds left before expiry, while inside the warning window.
   * `null` outside it (including once expired — there is nothing to count
   * down to at that point). */
  readonly warningSecondsLeft: number | null;
}

export function computeIdleState(
  lastActivityAt: number,
  now: number,
  timeoutMs: number = IDLE_TIMEOUT_MS,
  warningLeadMs: number = IDLE_WARNING_LEAD_MS,
): IdleState {
  const remaining = timeoutMs - (now - lastActivityAt);
  if (remaining <= 0) return { expired: true, warningSecondsLeft: null };
  if (remaining <= warningLeadMs) return { expired: false, warningSecondsLeft: Math.ceil(remaining / 1000) };
  return { expired: false, warningSecondsLeft: null };
}
