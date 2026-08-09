/**
 * Session gate — the one place AOS decides "is anyone logged in, and who".
 *
 * Unauthenticated: renders the login screen and nothing else — no route in
 * `App.tsx` is reachable, including a case URL typed or pasted directly,
 * because `App` is simply never mounted (Employee Authentication milestone).
 *
 * Authenticated: mounts `SessionProvider` (and everything inside it) around
 * `children`. The session is restored from `localStorage` on refresh only if
 * the stored user still exists and is still active — an inactive or deleted
 * user is treated exactly like no session at all, never a silent fallback to
 * some other identity.
 */

import { useEffect, useState, type ReactNode } from "react";

import { LoginScreen } from "../screens/LoginScreen.js";
import { SessionProvider } from "../session.js";
import { useDatabase } from "../fake/useDatabase.js";
import type { Id } from "../fake/types.js";

const SESSION_KEY = "aos.session";

function readStoredUserId(): Id | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function writeStoredUserId(userId: Id | null): void {
  try {
    if (userId) {
      localStorage.setItem(SESSION_KEY, userId);
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // Private browsing or over quota — the session just will not survive a
    // refresh, which is a worse experience than a crash, not a wrong one.
  }
}

export function AuthGate({ children }: { children: ReactNode }): ReactNode {
  const db = useDatabase();
  const [userId, setUserId] = useState<Id | null>(readStoredUserId);

  const user = userId ? db.users.find((u) => u.id === userId) : undefined;
  const authenticated = user !== undefined && user.isActive;

  // The stored id no longer resolves to a live, active account — a
  // deactivated or deleted employee, or a corrupted value. Clear it rather
  // than rendering a stale identity; the effect (not the render) is what
  // performs the storage write.
  useEffect(() => {
    if (userId !== null && !authenticated) {
      writeStoredUserId(null);
      setUserId(null);
    }
  }, [userId, authenticated]);

  if (!authenticated || !user) {
    return (
      <LoginScreen
        onLogin={(id) => {
          writeStoredUserId(id);
          setUserId(id);
        }}
      />
    );
  }

  return (
    <SessionProvider
      user={user}
      onLogout={() => {
        writeStoredUserId(null);
        setUserId(null);
      }}
    >
      {children}
    </SessionProvider>
  );
}
