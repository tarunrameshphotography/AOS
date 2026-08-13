/**
 * Session gate — the one place AOS decides "is anyone logged in, and who".
 *
 * STAGE 3B CHANGED WHERE THE ANSWER COMES FROM. It used to be a user id in
 * localStorage resolved against the prototype store's own `db.users`, which
 * meant "logged in" was a claim the browser made about itself: clearing the
 * value logged you out, and writing somebody else's id in logged you in as
 * them. It is now a bearer token the server issued, and the identity behind it
 * is whatever `GET /api/auth/me` says it is. The browser can throw the token
 * away; it cannot forge one.
 *
 * Unauthenticated: renders the login screen and nothing else. No route in
 * `App.tsx` is reachable, including a case URL typed or pasted directly,
 * because `App` is never mounted. That was true before and stays true — but it
 * is no longer the thing keeping a case private. The server refuses the
 * request regardless of what the browser renders.
 *
 * Authenticated: mounts `SessionProvider` around `children`.
 *
 * On refresh the token is validated against the server before anything is
 * rendered. An expired token, a revoked session, or an account a manager
 * deactivated five minutes ago all resolve to "no session" — never a silent
 * fallback to some other identity, and never a stale name in the corner of a
 * screen the server would refuse to serve.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { api, onUnauthorized, storeToken, storedToken } from "../api/client.js";
import type { ApiSessionUser } from "../api/types.js";
import { LoginScreen } from "../screens/LoginScreen.js";
import { SessionProvider } from "../session.js";
import { adoptAuthenticatedUser, forgetAuthenticatedUser } from "../fake/store.js";
import { IdleSessionMonitor } from "./IdleSessionMonitor.js";

type State =
  | { readonly status: "checking" }
  | { readonly status: "anonymous" }
  | { readonly status: "authenticated"; readonly user: ApiSessionUser };

export function AuthGate({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<State>(() =>
    storedToken() === null ? { status: "anonymous" } : { status: "checking" },
  );
  // Shown once on the login screen after an idle sign-out, then cleared —
  // distinct from `LoginScreen`'s own error state, which is about a wrong
  // password, not why the form is here at all.
  const [notice, setNotice] = useState<string | null>(null);

  const adopt = useCallback((user: ApiSessionUser) => {
    // The prototype half of the app still authorises through `fake/store.ts`,
    // which looks the actor up in its own user list. See the function's
    // comment: this is an identity bridge for the screens that have not
    // migrated, and carries no customer or case data.
    adoptAuthenticatedUser(user);
    setNotice(null);
    setState({ status: "authenticated", user });
  }, []);

  // Fires when `IdleSessionMonitor`'s local clock reaches the idle timeout
  // with no "Continue session" click. The server would refuse the next
  // request anyway (Backend/api-server.ts's `loadActor`) — this just gets
  // there without waiting for one, and says why, which a stray 401 would not.
  const expireIdle = useCallback(() => {
    storeToken(null);
    forgetAuthenticatedUser();
    setNotice("You were signed out after 5 minutes of inactivity.");
    setState({ status: "anonymous" });
  }, []);

  // Restore on load, and re-validate rather than trusting the stored token.
  useEffect(() => {
    if (state.status !== "checking") return;
    let cancelled = false;

    api<ApiSessionUser>("/auth/me")
      .then((user) => {
        if (!cancelled) adopt(user);
      })
      .catch(() => {
        if (cancelled) return;
        storeToken(null);
        forgetAuthenticatedUser();
        setState({ status: "anonymous" });
      });

    return () => {
      cancelled = true;
    };
  }, [state.status, adopt]);

  // Any request, anywhere, that comes back 401 ends the session. An employee
  // deactivated mid-shift is returned to the login screen rather than left
  // clicking buttons that all fail.
  useEffect(
    () =>
      onUnauthorized(() => {
        forgetAuthenticatedUser();
        setState({ status: "anonymous" });
      }),
    [],
  );

  const logout = useCallback(() => {
    void (async () => {
      // AWAITED, deliberately. A token merely forgotten by one browser is
      // still a valid token until the server revokes it, and firing this
      // without waiting means a click on "Log out" followed by closing the tab
      // can lose the revocation entirely — on a shared office PC that is the
      // difference between logging out and appearing to.
      //
      // The local state is cleared either way: if the API is unreachable, the
      // employee still expects "log out" to log them out of the machine in
      // front of them, and the token expires on its own within the day.
      try {
        await api("/auth/logout", { method: "POST" });
      } catch {
        // Nothing to tell them — the sign-out below happens regardless.
      }
      storeToken(null);
      forgetAuthenticatedUser();
      setState({ status: "anonymous" });
    })();
  }, []);

  if (state.status === "checking") {
    // Deliberately not the login form. Flashing "sign in" at somebody who IS
    // signed in, for the length of one request, trains them to type their
    // password into a screen that was about to disappear.
    return (
      <div className="grid min-h-full place-items-center bg-canvas">
        <p className="text-sm text-ink-500">Restoring your session…</p>
      </div>
    );
  }

  if (state.status === "anonymous") {
    return <LoginScreen onAuthenticated={adopt} notice={notice} />;
  }

  return (
    <SessionProvider user={state.user} onLogout={logout}>
      <IdleSessionMonitor onExpire={expireIdle} />
      {children}
    </SessionProvider>
  );
}
