/**
 * The "Continue session" warning that appears shortly before the server's
 * idle timeout would end this session.
 *
 * Mounted only while authenticated (see `AuthGate.tsx`), so it never runs —
 * and never counts as activity of any kind — while nobody is signed in.
 *
 * WHY A CLIENT-SIDE TIMER AT ALL, WHEN THE SERVER IS THE AUTHORITY. It has to
 * be: the warning has to appear before expiry, and the server has no way to
 * push anything to an idle tab. This component never decides whether the
 * session is valid — `computeIdleState` mirrors the server's rule closely
 * enough to time the warning, but the only thing that actually keeps the
 * session alive is a real authenticated request, same as always. If this
 * component vanished entirely, an idle session would still expire correctly;
 * employees would just stop getting warned first.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { api, getLastActivityAt, onActivity } from "../api/client.js";
import { Button, Modal } from "../ui/index.js";
import { computeIdleState } from "./idle.js";

const POLL_MS = 1000;

export function IdleSessionMonitor({ onExpire }: { onExpire: () => void }): ReactNode {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    const tick = (): void => {
      const state = computeIdleState(getLastActivityAt(), Date.now());
      if (state.expired) {
        onExpire();
        return;
      }
      setSecondsLeft(state.warningSecondsLeft);
    };

    tick();
    const interval = setInterval(tick, POLL_MS);
    // Recomputes the moment activity elsewhere resets the clock, rather than
    // leaving the warning showing for up to a second after a request that
    // should have dismissed it already.
    const unsubscribe = onActivity(tick);
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, [onExpire]);

  const continueSession = useCallback(() => {
    // Any authenticated request refreshes the server's idle clock
    // (`loadActor` in Backend/api-server.ts) — `/auth/me` is the cheapest one
    // that already exists. Its own success updates this module's activity
    // tracker (Frontend/src/api/client.ts), which dismisses the warning on
    // the next tick. A failure here means the session is already gone; api()
    // turns a 401 into the ordinary "session ended" path, so nothing extra is
    // needed here.
    void api("/auth/me").catch(() => {});
  }, []);

  return (
    <Modal open={secondsLeft !== null} title="Still there?" onClose={continueSession}>
      <p className="text-sm text-ink-700">
        You have been idle for a while. For your security, AOS will sign you out in{" "}
        <strong>
          {secondsLeft ?? 0} second{secondsLeft === 1 ? "" : "s"}
        </strong>{" "}
        unless you continue.
      </p>
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={continueSession}>
          Continue session
        </Button>
      </div>
    </Modal>
  );
}
