/**
 * Who is using AOS right now, and what they may do.
 *
 * Identity comes from a real login (Employee Authentication milestone) —
 * `AuthGate` resolves an authenticated `userId` and passes it here as a prop.
 * `SessionProvider` no longer owns switchable identity state itself; it only
 * renders the session for the user `AuthGate` has already authenticated, and
 * exposes `logout` to end it.
 *
 * Permission answers come from `hasPermissionWithOverrides` in
 * src/domain/permissions/ — role grants plus this user's own explicit
 * grants/denials, the one place this question is answered anywhere in AOS.
 * The UI reads permissions to decide what to show, as a courtesy — it is not
 * a control (BR-060); the store's own `authorize()`/`canActOnCase()` guards
 * are what actually enforce it on every write, and `CaseDetail`'s read gate
 * enforces it on reads reached by direct URL.
 */

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { hasPermissionWithOverrides, type Role, type Scope } from "@domain/permissions/index.js";

import type { AppUser } from "./fake/types.js";

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
 * because Manager and Managing Partner now both land in "management"
 * (Employee Authentication milestone) — never a restriction, same as before.
 */
const WORKSPACE_ROLES: Record<Workspace, readonly Role[]> = {
  calling: ["telecaller"],
  login_desk: ["login_executive"],
  management: ["manager", "managing_partner"],
  finance: ["finance"],
  admin: ["admin"],
};

interface SessionValue {
  user: AppUser;
  roles: readonly Role[];
  workspace: Workspace;
  /** Workspaces this user's roles make meaningful. Others are still reachable. */
  availableWorkspaces: readonly Workspace[];
  setWorkspace: (workspace: Workspace) => void;
  can: (permission: string, scope?: Scope) => boolean;
  /** Ends the session and returns to the login screen. */
  logout: () => void;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Renders the authenticated session for `user`. `AuthGate` is what decides
 * who `user` is (via real login) and only mounts this once someone has
 * actually authenticated — there is no switchable-identity state in here any
 * more, and no way to reach another employee's session from inside the app.
 */
export function SessionProvider({
  user,
  onLogout,
  children,
}: {
  user: AppUser;
  onLogout: () => void;
  children: ReactNode;
}): ReactNode {
  const [workspaceOverride, setWorkspaceOverride] = useState<Workspace | null>(null);

  const value = useMemo<SessionValue>(() => {
    const roles = user.roles;
    const overrides = (user.permissionOverrides ?? []).filter((o) => !o.revokedAt);
    const available = WORKSPACES.filter((workspace) =>
      WORKSPACE_ROLES[workspace].some((role) => roles.includes(role)),
    );
    const primaryRole = roles[0] ?? "telecaller";

    return {
      user,
      roles,
      workspace: workspaceOverride ?? available[0] ?? DEFAULT_WORKSPACE[primaryRole],
      availableWorkspaces: available.length > 0 ? available : [DEFAULT_WORKSPACE[primaryRole]],
      setWorkspace: setWorkspaceOverride,
      can: (permission: string, scope: Scope = "own") =>
        hasPermissionWithOverrides(roles as Role[], overrides, permission, scope),
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
