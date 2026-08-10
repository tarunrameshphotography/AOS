/**
 * Who is using AOS right now, and what they may do.
 *
 * Identity comes from the SERVER as of Stage 3B — `AuthGate` exchanges a
 * bearer token for `GET /api/auth/me` and passes the result here. Before that
 * it came from the prototype store's own user list, which meant the browser
 * was asserting its own identity; now it is reporting one the server issued.
 *
 * Permission answers come from `hasPermissionWithOverrides` in
 * `src/domain/permissions/` — role grants plus this user's own explicit
 * grants and denials, which the server now sends with the session. That is the
 * ONE implementation of this question in AOS: the API's `authorize.ts` calls
 * the same function on the same catalogue. There is deliberately no
 * frontend-specific permission model, because two implementations of "may
 * they?" is how a button appears for someone the server will refuse.
 *
 * NONE OF THIS IS A SECURITY BOUNDARY (BR-060). `session.can()` decides what
 * is DRAWN. Every request is re-checked server-side against overrides read
 * fresh from the database, so a user who edits their own session state gains a
 * visible button and a 403 behind it.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { hasPermissionWithOverrides, type Role, type Scope } from "@domain/permissions/index.js";

import type { ApiSessionUser } from "./api/types.js";

/**
 * Workspaces are an interface context with no security meaning whatsoever
 * (ADR-022, BR-063). Switching workspace never changes what you may do.
 */
export const WORKSPACES = ["calling", "login_desk", "management", "finance", "admin"] as const;

export type Workspace = (typeof WORKSPACES)[number];

export const WORKSPACE_LABELS: Record<Workspace, string> = {
  calling: "Calling",
  login_desk: "Login Desk",
  management: "Management",
  finance: "Finance",
  admin: "Administration",
};

/** The one question each workspace answers (Principle #2). */
export const WORKSPACE_QUESTIONS: Record<Workspace, string> = {
  calling: "Who do I call next?",
  login_desk: "What is missing before this file goes to the bank?",
  management: "Which cases need attention today?",
  finance: "What is owed, and what is collected?",
  admin: "Is the system healthy?",
};

/** Which workspace a role naturally lands in. Never a restriction. */
const DEFAULT_WORKSPACE: Record<Role, Workspace> = {
  telecaller: "calling",
  login_executive: "login_desk",
  manager: "management",
  finance: "finance",
  admin: "admin",
  // Employee Authentication milestone: Managing Partner is set equal to
  // Manager for now (src/domain/permissions/roles.ts), so it shares the same
  // workspace.
  managing_partner: "management",
};

/**
 * Which roles make a workspace meaningful. A list rather than one role each,
 * because Manager and Managing Partner both land in "management" — never a
 * restriction, same as before.
 */
const WORKSPACE_ROLES: Record<Workspace, readonly Role[]> = {
  calling: ["telecaller"],
  login_desk: ["login_executive"],
  management: ["manager", "managing_partner"],
  finance: ["finance"],
  admin: ["admin"],
};

interface SessionValue {
  /** The signed-in employee, as the server describes them. */
  user: ApiSessionUser;
  /** Their display name. Named separately because the API calls it `fullName`
   * and half the prototype calls it `name`; screens should read this. */
  displayName: string;
  roles: readonly Role[];
  workspace: Workspace;
  /** Workspaces this user's roles make meaningful. Others are still reachable. */
  availableWorkspaces: readonly Workspace[];
  setWorkspace: (workspace: Workspace) => void;
  can: (permission: string, scope?: Scope) => boolean;
  /** `can` at `all`, or `can` at `own` while actually owning the thing. The
   * exact rule `canActOnCase` applies on the server, so the UI and the API
   * agree about a Telecaller's own case. */
  canActOnCase: (ownerUserId: string, permission: string) => boolean;
  /** Ends the session and returns to the login screen. */
  logout: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({
  user,
  onLogout,
  children,
}: {
  user: ApiSessionUser;
  onLogout: () => void;
  children: ReactNode;
}): ReactNode {
  const [workspaceOverride, setWorkspaceOverride] = useState<Workspace | null>(null);

  const value = useMemo<SessionValue>(() => {
    const roles = user.roles;
    const overrides = user.overrides;
    const available = WORKSPACES.filter((workspace) =>
      WORKSPACE_ROLES[workspace].some((role) => roles.includes(role)),
    );
    const primaryRole = roles[0] ?? "telecaller";

    const can = (permission: string, scope: Scope = "own"): boolean =>
      hasPermissionWithOverrides(roles as Role[], overrides, permission, scope);

    return {
      user,
      displayName: user.fullName,
      roles,
      workspace: workspaceOverride ?? available[0] ?? DEFAULT_WORKSPACE[primaryRole],
      availableWorkspaces: available.length > 0 ? available : [DEFAULT_WORKSPACE[primaryRole]],
      setWorkspace: setWorkspaceOverride,
      can,
      canActOnCase: (ownerUserId: string, permission: string) =>
        can(permission, "all") || (can(permission, "own") && ownerUserId === user.id),
      logout: onLogout,
    };
  }, [user, workspaceOverride, onLogout]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used inside SessionProvider");
  }
  return value;
}
