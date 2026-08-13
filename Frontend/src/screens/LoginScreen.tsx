/**
 * Login screen.
 *
 * The application's front door — an internal business tool, not a consumer
 * product, so this stays plain: mark, two fields, one action, a clear error.
 *
 * Stage 3B: the credentials go to the server. `POST /api/auth/login` verifies
 * the password against `app_user.password_hash` in PostgreSQL and issues a
 * session token; the browser no longer holds any password material and no
 * longer decides whether the answer was right. The failure message is the
 * server's, which is one message for "no such user", "wrong password" and
 * "deactivated" — the login form must not become a way to enumerate who works
 * here.
 */

import { useState, type FormEvent, type ReactNode } from "react";

import { api, storeToken } from "../api/client.js";
import type { ApiSessionUser } from "../api/types.js";
import { Button, Field, Input } from "../ui/index.js";

interface LoginResponse {
  readonly token: string;
  readonly user: ApiSessionUser;
}

export function LoginScreen({
  onAuthenticated,
  notice,
}: {
  onAuthenticated: (user: ApiSessionUser) => void;
  /** Why the form is here, when it is not the first visit — e.g. an idle
   * sign-out. Not an error: shown in a neutral tone, separate from `error`
   * below, and cleared the moment sign-in succeeds. */
  notice?: string | null;
}): ReactNode {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      // `anonymous` so a wrong password — a 401 — is shown as a wrong
      // password, rather than tripping the global "your session ended" path.
      const result = await api<LoginResponse>("/auth/login", {
        method: "POST",
        body: { username: username.trim(), password },
        anonymous: true,
      });
      storeToken(result.token);
      onAuthenticated(result.user);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-7 shadow-elevated ring-1 ring-ink-150">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-brand-600 text-sm font-bold text-white">
            AL
          </span>
          <div>
            <p className="font-display text-sm font-semibold text-ink-900">
              Amaze Operating System
            </p>
            <p className="text-xs text-ink-500">Sign in with your employee ID</p>
          </div>
        </div>

        {notice && (
          <p className="mb-4 rounded-md bg-brand-50 px-3 py-2 text-sm text-ink-700" role="status">
            {notice}
          </p>
        )}

        <form className="space-y-4" onSubmit={handleSubmit}>
          <Field label="Username / Employee ID">
            <Input
              autoFocus
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </Field>

          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="primary"
            className="w-full justify-center"
            disabled={submitting || !username || !password}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
