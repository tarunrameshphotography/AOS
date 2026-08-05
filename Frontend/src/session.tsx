/**
 * Who is using AOS right now, and what they may do.
 *
 * The prototype lets you switch user freely — there is no auth — because the
 * most useful thing to *experience* is how differently the product behaves for a
 * telecaller and a finance user. Switching is the demo, not a shortcut.
 *
 * Permission answers come from `hasPermission` in src/domain/permissions/, the
 * same function the server will use. The UI reads permissions to decide what to
 * show, as a courtesy — it is not a control (BR-060).
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { type Role, hasPermission } from "@domain/permissions/index.js";
import type { Scope } from "@domain/permissions/index.js";

import { useDatabase } from "./fake/useDatabase.js";
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
};

const WORKSPACE_ROLE: Record<Workspace, Role> = {
  calling: "telecaller",
  login_desk: "login_executive",
  management: "manager",
  finance: "finance",
  admin: "admin",
};

interface SessionValue {
  user: AppUser;
  roles: readonly Role[];
  workspace: Workspace;
  /** Workspaces this user's roles make meaningful. Others are still reachable. */
  availableWorkspaces: readonly Workspace[];
  setUserId: (id: string) => void;
  setWorkspace: (workspace: Workspace) => void;
  can: (permission: string, scope?: Scope) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const db = useDatabase();
  const [userId, setUserIdRaw] = useState<string>(() =>
    localStorage.getItem("aos.prototype.user") ?? "usr_001",
  );
  const [workspaceOverride, setWorkspaceOverride] = useState<Workspace | null>(null);

  const user = db.users.find((u) => u.id === userId) ?? db.users[0];

  const setUserId = useCallback((id: string) => {
    localStorage.setItem("aos.prototype.user", id);
    setUserIdRaw(id);
    setWorkspaceOverride(null);
  }, []);

  const value = useMemo<SessionValue | null>(() => {
    if (!user) {
      return null;
    }

    const roles = user.roles;
    const available = WORKSPACES.filter((workspace) =>
      roles.includes(WORKSPACE_ROLE[workspace]),
    );
    const primaryRole = roles[0] ?? "telecaller";

    return {
      user,
      roles,
      workspace: workspaceOverride ?? available[0] ?? DEFAULT_WORKSPACE[primaryRole],
      availableWorkspaces: available.length > 0 ? available : [DEFAULT_WORKSPACE[primaryRole]],
      setUserId,
      setWorkspace: setWorkspaceOverride,
      can: (permission: string, scope: Scope = "own") =>
        hasPermission(roles as Role[], permission, scope),
    };
  }, [user, workspaceOverride, setUserId]);

  if (!value) {
    return <div className="p-8">No users in the store. Reset the prototype.</div>;
  }

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error("useSession must be used inside SessionProvider");
  }
  return value;
}
