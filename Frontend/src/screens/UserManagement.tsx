/**
 * User Management — employee accounts, roles and per-user access.
 *
 * STAGE 3C-0: THIS SCREEN NOW TALKS TO POSTGRESQL. Until this stage it was the
 * last administrative surface still driving `Frontend/src/fake/store.ts` — an
 * object graph in one browser's localStorage. That meant a Manager could
 * "create a user" who existed on their PC and nowhere else, "deactivate" a
 * leaver who could still sign in from any other machine, and "grant a
 * permission" the server had never heard of. Every one of those actions now
 * goes to `Backend/users.ts` and lands in the database, and the effects are
 * immediate for everyone: `loadActor` re-reads roles, overrides and
 * `is_active` on every single request.
 *
 * THE SERVER IS THE AUTHORITY, NOT THIS FILE. The gates below decide what is
 * DRAWN. `Backend/users.ts` re-checks `user.manage`, `role.assign` and
 * `permission.override` on every call, against overrides read fresh, and
 * refuses in its own words — which is what this screen shows when it happens
 * (BR-060). A tampered client gets a visible button and a 403 behind it.
 *
 * EFFECTIVE ACCESS IS COMPUTED SERVER-SIDE and rendered as sent. The previous
 * version called `effectivePermissionsWithOverrides` here, in the browser. It
 * is the same function the server calls, so it gave the same answer — but a
 * screen whose job is to display what the server believes must not compute its
 * own second opinion, because the day the two disagree is the day this screen
 * lies about someone's access (ADR-022).
 *
 * WHAT IS GONE: "Delete account". The API has no delete and will not get one —
 * BR-062 requires a departed employee's name to survive on everything they
 * touched, and `app_user` is referenced by ten-odd tables. Deactivation is the
 * supported path and is what the real accounts use. The button existed in the
 * prototype because deleting a row from an in-memory array was free.
 *
 * Permission keys are never shown as the primary label — `PERMISSION_DISPLAY_NAME`
 * supplies a phrase ("View all cases") and the raw key sits behind the same
 * "Technical detail" disclosure `PermissionCode` already uses elsewhere.
 */

import { useState, type ReactNode } from "react";

import {
  PERMISSIONS,
  PERMISSION_DISPLAY_NAME,
  ROLES,
  ROLE_LABELS,
  SCOPES,
  type PermissionGroup,
  type Role,
  type Scope,
} from "@domain/permissions/index.js";

import { api } from "../api/client.js";
import { useApiQuery, useMutation } from "../api/hooks.js";
import type { ApiUser, ApiUserPermissions } from "../api/types.js";
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
  const mayManage = session.can("user.manage", "all");

  const [createOpen, setCreateOpen] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);

  // `null` skips the request entirely: someone without the permission should
  // not fire a call they will be refused, and see a red error where an
  // explanation belongs.
  const users = useApiQuery<readonly ApiUser[]>(mayManage ? "/users" : null);

  if (!mayManage) {
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
        subtitle="Employee accounts, roles, and access. Changes take effect immediately, everywhere."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            Create user
          </Button>
        }
      >
        {users.loading && <Empty>Loading…</Empty>}
        {users.error && <Empty>{users.error.message}</Empty>}
        {users.data && users.data.length === 0 && <Empty>No accounts yet.</Empty>}

        {users.data && (
          <ul className="divide-y divide-ink-100">
            {users.data.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                expanded={expandedUserId === user.id}
                onToggle={() =>
                  setExpandedUserId((current) => (current === user.id ? null : user.id))
                }
                onChanged={users.refetch}
              />
            ))}
          </ul>
        )}
      </Card>

      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={users.refetch}
      />
    </div>
  );
}

function UserRow({
  user,
  expanded,
  onToggle,
  onChanged,
}: {
  user: ApiUser;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}): ReactNode {
  const session = useSession();
  const isSelf = user.id === session.user.id;

  return (
    <li className="py-3" data-testid="user-row" data-username={user.username}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink-900">
            <span>{user.fullName}</span>
            {isSelf && <span className="ml-1.5 text-xs font-normal text-ink-400">(you)</span>}
          </p>
          <p className="truncate text-xs text-ink-500">{user.username}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* The roles this account HOLDS, as opposed to the tick-boxes below
              that propose a change to them. They read identically, so the
              summary is marked to be addressable on its own. */}
          <span className="flex items-center gap-2" data-testid="assigned-roles">
            {user.roles.map((role) => (
              <Badge key={role}>{ROLE_LABELS[role]}</Badge>
            ))}
          </span>
          <Badge tone={user.isActive ? "good" : "bad"}>
            {user.isActive ? "Active" : "Disabled"}
          </Badge>
          <Button variant="ghost" onClick={onToggle}>
            {expanded ? "Close" : "Manage"}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 space-y-4 rounded-md bg-ink-50 p-3">
          <RolesEditor user={user} onChanged={onChanged} />
          <AccountActions user={user} isSelf={isSelf} onChanged={onChanged} />
          <ResetPasswordForm user={user} />
          <AccessPanel user={user} />
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function RolesEditor({ user, onChanged }: { user: ApiUser; onChanged: () => void }): ReactNode {
  const toast = useToast();
  const mutation = useMutation();
  const [roles, setRoles] = useState<Role[]>([...user.roles]);

  const dirty =
    roles.length !== user.roles.length || roles.some((role) => !user.roles.includes(role));

  function toggle(role: Role): void {
    setRoles((current) =>
      current.includes(role) ? current.filter((r) => r !== role) : [...current, role],
    );
  }

  async function save(): Promise<void> {
    const result = await mutation.run(() =>
      api<ApiUser>(`/users/${user.id}/roles`, { method: "PUT", body: { roles } }),
    );
    if (result) {
      toast.show("Roles updated.", "good");
      onChanged();
    }
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
        <Button className="mt-2" variant="primary" onClick={save} disabled={mutation.pending}>
          Save roles
        </Button>
      )}
      <Refusal message={mutation.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account state
// ---------------------------------------------------------------------------

function AccountActions({
  user,
  isSelf,
  onChanged,
}: {
  user: ApiUser;
  isSelf: boolean;
  onChanged: () => void;
}): ReactNode {
  const toast = useToast();
  const mutation = useMutation();

  async function toggleActive(): Promise<void> {
    const result = await mutation.run(() =>
      api<ApiUser>(`/users/${user.id}/active`, {
        method: "PUT",
        body: { isActive: !user.isActive },
      }),
    );
    if (result) {
      toast.show(user.isActive ? "User deactivated." : "User reactivated.", "good");
      onChanged();
    }
  }

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-ink-700">Account state</p>
      <Button variant="secondary" onClick={toggleActive} disabled={mutation.pending || isSelf}>
        {user.isActive ? "Deactivate" : "Reactivate"}
      </Button>
      <p className="mt-1 text-xs text-ink-500">
        {isSelf
          ? "You cannot deactivate your own account."
          : "Deactivating ends their sessions at once and stops them signing in. Accounts are never deleted — their name stays on everything they worked on."}
      </p>
      <Refusal message={mutation.error} />
    </div>
  );
}

function ResetPasswordForm({ user }: { user: ApiUser }): ReactNode {
  const toast = useToast();
  const mutation = useMutation();
  const [password, setPassword] = useState("");

  async function submit(): Promise<void> {
    // Sent as typed, over the app's own origin, and hashed by the server
    // (PBKDF2, `src/domain/auth/password.ts`). The prototype hashed in the
    // browser, which sounds safer and is not: a client-computed hash IS the
    // credential to whoever holds it, and the server then has no way to
    // enforce a password rule it cannot see.
    const result = await mutation.run(() =>
      api<{ ok: true }>(`/users/${user.id}/password`, { method: "PUT", body: { password } }),
    );
    if (result) {
      toast.show("Password reset.", "good");
      setPassword("");
    }
  }

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-ink-700">Reset password</p>
      <div className="flex gap-2">
        <Input
          type="password"
          name="newPassword"
          aria-label="New password"
          placeholder="New password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="max-w-56"
        />
        <Button variant="secondary" onClick={submit} disabled={mutation.pending || !password}>
          Reset
        </Button>
      </div>
      <p className="mt-1 text-xs text-ink-500">
        Their existing sessions end immediately.
      </p>
      <Refusal message={mutation.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Effective access and overrides
// ---------------------------------------------------------------------------

/**
 * One request answers both halves of this panel.
 *
 * `GET /api/users/:id/permissions` returns the live overrides AND the
 * resulting effective access, because they are one question — "what can this
 * person do, and which part of it is an exception someone made for them". It
 * requires `permission.override`, which is deliberately narrower than
 * `user.read`: seeing that a colleague is a Telecaller is ordinary, seeing
 * that somebody carved out an exception for them is administration.
 */
function AccessPanel({ user }: { user: ApiUser }): ReactNode {
  const session = useSession();
  const mayOverride = session.can("permission.override", "all");
  const access = useApiQuery<ApiUserPermissions>(
    mayOverride ? `/users/${user.id}/permissions` : null,
  );

  if (!mayOverride) return null;
  if (access.loading) return <p className="text-sm text-ink-500">Loading access…</p>;
  if (access.error) return <p className="text-sm text-red-700">{access.error.message}</p>;
  if (!access.data) return null;

  return (
    <>
      <EffectiveAccess access={access.data} />
      <OverridesEditor user={user} access={access.data} onChanged={access.refetch} />
    </>
  );
}

function EffectiveAccess({ access }: { access: ApiUserPermissions }): ReactNode {
  const byPermission = new Map(access.effective.map((entry) => [entry.permission, entry]));

  const granted = PERMISSIONS.filter((permission) => {
    const status = byPermission.get(permission.key);
    return status?.kind === "role" || status?.kind === "override_grant";
  });
  const denied = PERMISSIONS.filter(
    (permission) => byPermission.get(permission.key)?.kind === "override_deny",
  );

  return (
    <div data-testid="effective-access">
      <p className="mb-1.5 text-xs font-semibold text-ink-700">Effective access</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className="mb-1 text-xs text-ink-500">Granted</p>
          <ul className="space-y-0.5">
            {granted.map((permission) => {
              const isOverride = byPermission.get(permission.key)?.kind === "override_grant";
              return (
                <li key={permission.key} className="text-sm">
                  {PERMISSION_DISPLAY_NAME[permission.key] ?? permission.key}
                  {isOverride && (
                    <span className="ml-1.5 text-xs font-medium text-brand-700">(override)</span>
                  )}
                  <PermissionCode code={permission.key} />
                </li>
              );
            })}
            {granted.length === 0 && <li className="text-sm text-ink-400">Nothing granted.</li>}
          </ul>
        </div>
        <div>
          <p className="mb-1 text-xs text-ink-500">Denied (overrides role)</p>
          <ul className="space-y-0.5">
            {denied.map((permission) => (
              <li key={permission.key} className="text-sm text-red-700">
                {PERMISSION_DISPLAY_NAME[permission.key] ?? permission.key}
                <PermissionCode code={permission.key} />
              </li>
            ))}
            {denied.length === 0 && <li className="text-sm text-ink-400">No explicit denials.</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * Grant or deny one permission for one person.
 *
 * Precedence — deny beats grant beats role — is decided by
 * `hasPermissionWithOverrides` on the server and is not restated here. This
 * records a decision; it does not resolve one.
 */
function OverridesEditor({
  user,
  access,
  onChanged,
}: {
  user: ApiUser;
  access: ApiUserPermissions;
  onChanged: () => void;
}): ReactNode {
  const toast = useToast();
  const mutation = useMutation();
  const [permission, setPermission] = useState(PERMISSIONS[0]?.key ?? "");
  const [scope, setScope] = useState<Scope>("all");

  async function decide(decision: "grant" | "deny"): Promise<void> {
    const result = await mutation.run(() =>
      api(`/users/${user.id}/overrides`, {
        method: "POST",
        body: { permission, scope, decision },
      }),
    );
    if (result) {
      toast.show(decision === "grant" ? "Permission granted." : "Permission denied.", "good");
      onChanged();
    }
  }

  async function revoke(overrideId: string): Promise<void> {
    const result = await mutation.run(() =>
      api(`/users/${user.id}/overrides/${overrideId}`, { method: "DELETE" }),
    );
    if (result) {
      toast.show("Override revoked.", "good");
      onChanged();
    }
  }

  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-ink-700">Grant or deny a permission</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Permission"
          value={permission}
          onChange={(event) => setPermission(event.target.value)}
          className="max-w-72"
        >
          {groupPermissionsByCategory().map(([group, permissions]) => (
            <optgroup key={group} label={GROUP_LABELS[group]}>
              {permissions.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {PERMISSION_DISPLAY_NAME[entry.key] ?? entry.key}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <Select
          aria-label="Scope"
          value={scope}
          onChange={(event) => setScope(event.target.value as Scope)}
          className="max-w-28"
        >
          {SCOPES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </Select>
        <Button variant="secondary" onClick={() => decide("grant")} disabled={mutation.pending}>
          Grant
        </Button>
        <Button variant="danger" onClick={() => decide("deny")} disabled={mutation.pending}>
          Deny
        </Button>
      </div>

      {access.overrides.length > 0 && (
        <ul className="mt-2 space-y-1" data-testid="overrides">
          {access.overrides.map((override) => (
            <li key={override.id} className="flex items-center justify-between text-sm">
              <span
                className={cx(
                  override.decision === "deny" ? "text-red-700" : "text-brand-700",
                )}
              >
                {override.decision === "grant" ? "Granted" : "Denied"}:{" "}
                {PERMISSION_DISPLAY_NAME[override.permission] ?? override.permission} (
                {override.scope})
                {override.grantedByName && (
                  <span className="ml-1.5 text-xs text-ink-500">by {override.grantedByName}</span>
                )}
              </span>
              <Button variant="ghost" onClick={() => revoke(override.id)} disabled={mutation.pending}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Refusal message={mutation.error} />
    </div>
  );
}

function groupPermissionsByCategory(): Array<[PermissionGroup, (typeof PERMISSIONS)[number][]]> {
  const byGroup = new Map<PermissionGroup, (typeof PERMISSIONS)[number][]>();
  for (const permission of PERMISSIONS) {
    const list = byGroup.get(permission.group) ?? [];
    list.push(permission);
    byGroup.set(permission.group, list);
  }
  return Array.from(byGroup.entries());
}

// ---------------------------------------------------------------------------
// Creating an account
// ---------------------------------------------------------------------------

function CreateUserModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): ReactNode {
  const toast = useToast();
  const mutation = useMutation();
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [roles, setRoles] = useState<Role[]>([]);

  function reset(): void {
    setFullName("");
    setUsername("");
    setPassword("");
    setRoles([]);
    mutation.clearError();
  }

  function toggleRole(role: Role): void {
    setRoles((current) =>
      current.includes(role) ? current.filter((r) => r !== role) : [...current, role],
    );
  }

  async function submit(): Promise<void> {
    // Validation lives on the server — the name, the username clash, the
    // password length and the role list are all checked there, in its own
    // words, because those are the rules that bind. Repeating them here would
    // be a second set to keep in step.
    const result = await mutation.run(() =>
      api<ApiUser>("/users", {
        method: "POST",
        body: { fullName, username, password, roles },
      }),
    );
    if (result) {
      toast.show("User created.", "good");
      reset();
      onCreated();
      onClose();
    }
  }

  return (
    <Modal
      open={open}
      title="Create user"
      onClose={() => {
        reset();
        onClose();
      }}
    >
      <div className="space-y-3">
        <Field label="Name">
          <Input name="fullName" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="Username / Employee ID" hint="What they will sign in with.">
          <Input name="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Initial password" hint="At least 8 characters. They can change it later.">
          <Input
            type="password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-700">Roles</p>
          <div className="flex flex-wrap gap-3">
            {ROLES.map((role) => (
              <label key={role} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={roles.includes(role)}
                  onChange={() => toggleRole(role)}
                />
                {ROLE_LABELS[role]}
              </label>
            ))}
          </div>
        </div>
        <Refusal message={mutation.error} />
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="secondary"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={mutation.pending}
          >
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={mutation.pending}>
            {mutation.pending ? "Creating…" : "Create user"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The server's own refusal, shown where the action was taken.
 *
 * `role="alert"` because it is the answer to something the user just did, and
 * the text is the SERVER's — "That would leave nobody able to administer
 * users", "The username "tarun" is already in use" — never a rewrite of it.
 */
function Refusal({ message }: { message: string | null }): ReactNode {
  if (!message) return null;
  return (
    <p role="alert" className="mt-2 text-sm text-red-700">
      {message}
    </p>
  );
}
