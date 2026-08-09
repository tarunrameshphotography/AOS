/**
 * User Management (Employee Authentication milestone).
 *
 * Manager and Managing Partner both reach this screen — Manager currently
 * holds the same effective access as Managing Partner
 * (src/domain/permissions/roles.ts), which is why both may administer users
 * rather than just the latter. Gated on `user.manage`/`role.assign`/
 * `permission.override`, all at scope `all`; the store's own `authorize()`
 * enforces the same gate on every mutation independently of what this screen
 * shows or hides (Frontend/src/fake/store.ts) — this screen's own checks are
 * a courtesy, not the control.
 *
 * Permission keys are never shown as the primary label — `PERMISSION_DISPLAY_NAME`
 * supplies a phrase ("View all cases") and the raw key sits behind the same
 * "Technical detail" disclosure `PermissionCode` already uses elsewhere.
 */

import { useMemo, useState, type ReactNode } from "react";

import { hashPassword } from "@domain/auth/password.js";
import {
  PERMISSIONS,
  PERMISSION_DISPLAY_NAME,
  ROLES,
  ROLE_LABELS,
  SCOPES,
  effectivePermissionsWithOverrides,
  type PermissionGroup,
  type Role,
  type Scope,
} from "@domain/permissions/index.js";

import {
  createUser,
  deleteUser,
  resetUserPassword,
  revokePermissionOverride,
  setPermissionOverride,
  setUserActive,
  setUserRoles,
  type NewUserInput,
} from "../fake/store.js";
import { useDatabase } from "../fake/useDatabase.js";
import type { AppUser, Id } from "../fake/types.js";
import { useSession } from "../session.js";
import {
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Modal,
  PermissionCode,
  Select,
  cx,
  useToast,
} from "../ui/index.js";

const GROUP_LABELS: Record<PermissionGroup, string> = {
  cases: "Cases",
  "people-and-organisations": "People & organisations",
  documents: "Documents",
  banking: "Banking",
  "work-and-communication": "Work & communication",
  sensitive: "Sensitive",
  administration: "Administration",
};

export function UserManagement(): ReactNode {
  const session = useSession();
  const db = useDatabase();
  const [createOpen, setCreateOpen] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<Id | null>(null);

  if (!session.can("user.manage", "all")) {
    return (
      <Card title="User Management">
        <Empty>You do not have permission to manage users.</Empty>
        <PermissionCode code="user.manage" />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card
        title="User Management"
        subtitle="Employee accounts, roles, and access."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Create user
          </Button>
        }
      >
        <ul className="divide-y divide-ink-100">
          {db.users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              expanded={expandedUserId === user.id}
              onToggle={() =>
                setExpandedUserId((current) => (current === user.id ? null : user.id))
              }
            />
          ))}
        </ul>
      </Card>

      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        actorUserId={session.user.id}
      />
    </div>
  );
}

function UserRow({
  user,
  expanded,
  onToggle,
}: {
  user: AppUser;
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  const session = useSession();
  const isSelf = user.id === session.user.id;

  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink-900">
            <span>{user.name}</span>
            {isSelf && <span className="ml-1.5 text-xs font-normal text-ink-400">(you)</span>}
          </p>
          <p className="truncate text-xs text-ink-500">{user.username}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {user.roles.map((role) => (
            <Badge key={role}>{ROLE_LABELS[role]}</Badge>
          ))}
          <Badge tone={user.isActive ? "good" : "bad"}>{user.isActive ? "Active" : "Disabled"}</Badge>
          <Button variant="ghost" onClick={onToggle}>
            {expanded ? "Close" : "Manage"}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-4 rounded-md bg-ink-50 p-3">
          <RolesEditor user={user} actorUserId={session.user.id} />
          <AccountActions user={user} actorUserId={session.user.id} isSelf={isSelf} />
          <ResetPasswordForm user={user} actorUserId={session.user.id} />
          <EffectiveAccess user={user} />
          <OverridesEditor user={user} actorUserId={session.user.id} />
        </div>
      )}
    </li>
  );
}

function RolesEditor({ user, actorUserId }: { user: AppUser; actorUserId: Id }): ReactNode {
  const toast = useToast();
  const [roles, setRoles] = useState<Role[]>(user.roles);
  const dirty = roles.length !== user.roles.length || roles.some((r) => !user.roles.includes(r));

  function toggle(role: Role): void {
    setRoles((current) =>
      current.includes(role) ? current.filter((r) => r !== role) : [...current, role],
    );
  }

  function save(): void {
    const result = setUserRoles(user.id, roles, actorUserId);
    toast.show(result.ok ? "Roles updated." : (result.message ?? "Could not update roles."), result.ok ? "good" : "bad");
  }

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-ink-700">Roles</p>
      <div className="flex flex-wrap gap-3">
        {ROLES.map((role) => (
          <label key={role} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={roles.includes(role)} onChange={() => toggle(role)} />
            {ROLE_LABELS[role]}
          </label>
        ))}
      </div>
      {dirty && (
        <Button className="mt-2" variant="primary" onClick={save}>
          Save roles
        </Button>
      )}
    </div>
  );
}

function AccountActions({
  user,
  actorUserId,
  isSelf,
}: {
  user: AppUser;
  actorUserId: Id;
  isSelf: boolean;
}): ReactNode {
  const toast = useToast();

  function toggleActive(): void {
    const result = setUserActive(user.id, !user.isActive, actorUserId);
    toast.show(
      result.ok
        ? user.isActive
          ? "User deactivated."
          : "User reactivated."
        : (result.message ?? "Could not update account state."),
      result.ok ? "good" : "bad",
    );
  }

  function remove(): void {
    if (!confirm(`Delete ${user.name}'s account? This cannot be undone.`)) return;
    const result = deleteUser(user.id, actorUserId);
    toast.show(result.ok ? "User deleted." : (result.message ?? "Could not delete user."), result.ok ? "good" : "bad");
  }

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-ink-700">Account state</p>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={toggleActive} disabled={isSelf && user.isActive}>
          {user.isActive ? "Deactivate" : "Reactivate"}
        </Button>
        <Button variant="danger" onClick={remove} disabled={isSelf}>
          Delete account
        </Button>
      </div>
      {isSelf && (
        <p className="mt-1 text-xs text-ink-500">You cannot deactivate or delete your own account.</p>
      )}
    </div>
  );
}

function ResetPasswordForm({ user, actorUserId }: { user: AppUser; actorUserId: Id }): ReactNode {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (password.length < 8) {
      toast.show("Password must be at least 8 characters.", "bad");
      return;
    }
    setBusy(true);
    try {
      const passwordHash = await hashPassword(password);
      const result = resetUserPassword(user.id, passwordHash, actorUserId);
      toast.show(result.ok ? "Password reset." : (result.message ?? "Could not reset password."), result.ok ? "good" : "bad");
      if (result.ok) setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-ink-700">Reset password</p>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="max-w-56"
        />
        <Button variant="secondary" onClick={submit} disabled={busy || !password}>
          Reset
        </Button>
      </div>
    </div>
  );
}

function EffectiveAccess({ user }: { user: AppUser }): ReactNode {
  const effective = useMemo(
    () =>
      effectivePermissionsWithOverrides(
        user.roles,
        (user.permissionOverrides ?? []).filter((o) => !o.revokedAt),
      ),
    [user.roles, user.permissionOverrides],
  );

  const granted = PERMISSIONS.filter((p) => {
    const status = effective.get(p.key);
    return status?.kind === "role" || status?.kind === "override_grant";
  });
  const denied = PERMISSIONS.filter((p) => effective.get(p.key)?.kind === "override_deny");

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-ink-700">Effective access</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs text-ink-500">Granted</p>
          <ul className="space-y-0.5">
            {granted.map((p) => {
              const status = effective.get(p.key);
              const isOverride = status?.kind === "override_grant";
              return (
                <li key={p.key} className="text-sm">
                  {PERMISSION_DISPLAY_NAME[p.key] ?? p.key}
                  {isOverride && (
                    <span className="ml-1.5 text-xs font-medium text-brand-700">(override)</span>
                  )}
                  <PermissionCode code={p.key} />
                </li>
              );
            })}
            {granted.length === 0 && <li className="text-sm text-ink-400">Nothing granted.</li>}
          </ul>
        </div>
        <div>
          <p className="mb-1 text-xs text-ink-500">Denied (overrides role)</p>
          <ul className="space-y-0.5">
            {denied.map((p) => (
              <li key={p.key} className="text-sm text-red-700">
                {PERMISSION_DISPLAY_NAME[p.key] ?? p.key}
                <PermissionCode code={p.key} />
              </li>
            ))}
            {denied.length === 0 && <li className="text-sm text-ink-400">No explicit denials.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

function OverridesEditor({ user, actorUserId }: { user: AppUser; actorUserId: Id }): ReactNode {
  const session = useSession();
  const toast = useToast();
  const [permission, setPermission] = useState(PERMISSIONS[0]?.key ?? "");
  const [scope, setScope] = useState<Scope>("all");
  const activeOverrides = (user.permissionOverrides ?? []).filter((o) => !o.revokedAt);

  if (!session.can("permission.override", "all")) {
    return null;
  }

  function grant(decision: "grant" | "deny"): void {
    const result = setPermissionOverride(user.id, permission, scope, decision, actorUserId);
    toast.show(
      result.ok ? `Permission ${decision === "grant" ? "granted" : "denied"}.` : (result.message ?? "Could not set override."),
      result.ok ? "good" : "bad",
    );
  }

  function revoke(overrideId: Id): void {
    const result = revokePermissionOverride(user.id, overrideId, actorUserId);
    toast.show(result.ok ? "Override revoked." : (result.message ?? "Could not revoke override."), result.ok ? "good" : "bad");
  }

  const grouped = groupPermissionsByCategory();

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-ink-700">Grant or deny a permission</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={permission} onChange={(e) => setPermission(e.target.value)} className="max-w-72">
          {grouped.map(([group, permissions]) => (
            <optgroup key={group} label={GROUP_LABELS[group]}>
              {permissions.map((p) => (
                <option key={p.key} value={p.key}>
                  {PERMISSION_DISPLAY_NAME[p.key] ?? p.key}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)} className="max-w-28">
          {SCOPES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Button variant="secondary" onClick={() => grant("grant")}>
          Grant
        </Button>
        <Button variant="danger" onClick={() => grant("deny")}>
          Deny
        </Button>
      </div>

      {activeOverrides.length > 0 && (
        <ul className="mt-2 space-y-1">
          {activeOverrides.map((override) => (
            <li key={override.id} className="flex items-center justify-between text-sm">
              <span className={cx(override.decision === "deny" ? "text-red-700" : "text-brand-700")}>
                {override.decision === "grant" ? "Granted" : "Denied"}:{" "}
                {PERMISSION_DISPLAY_NAME[override.permission] ?? override.permission} ({override.scope})
              </span>
              <Button variant="ghost" onClick={() => revoke(override.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function groupPermissionsByCategory(): Array<[PermissionGroup, typeof PERMISSIONS extends readonly (infer T)[] ? T[] : never]> {
  const byGroup = new Map<PermissionGroup, (typeof PERMISSIONS)[number][]>();
  for (const permission of PERMISSIONS) {
    const list = byGroup.get(permission.group) ?? [];
    list.push(permission);
    byGroup.set(permission.group, list);
  }
  return Array.from(byGroup.entries());
}

function CreateUserModal({
  open,
  onClose,
  actorUserId,
}: {
  open: boolean;
  onClose: () => void;
  actorUserId: Id;
}): ReactNode {
  const toast = useToast();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [roles, setRoles] = useState<Role[]>([]);
  const [busy, setBusy] = useState(false);

  function reset(): void {
    setName("");
    setUsername("");
    setPassword("");
    setRoles([]);
  }

  function toggleRole(role: Role): void {
    setRoles((current) =>
      current.includes(role) ? current.filter((r) => r !== role) : [...current, role],
    );
  }

  async function submit(): Promise<void> {
    if (!name.trim() || !username.trim()) {
      toast.show("Name and username are required.", "bad");
      return;
    }
    if (password.length < 8) {
      toast.show("Password must be at least 8 characters.", "bad");
      return;
    }
    if (roles.length === 0) {
      toast.show("Select at least one role.", "bad");
      return;
    }

    setBusy(true);
    try {
      const passwordHash = await hashPassword(password);
      const input: NewUserInput = { name, username, passwordHash, roles };
      const result = createUser(input, actorUserId);
      if (result.ok) {
        toast.show("User created.", "good");
        reset();
        onClose();
      } else {
        toast.show(result.message ?? "Could not create user.", "bad");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Create user" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Username / Employee ID" hint="What they will sign in with.">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Initial password" hint="At least 8 characters. They can change it later.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-700">Roles</p>
          <div className="flex flex-wrap gap-3">
            {ROLES.map((role) => (
              <label key={role} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={roles.includes(role)} onChange={() => toggleRole(role)} />
                {ROLE_LABELS[role]}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create user"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
