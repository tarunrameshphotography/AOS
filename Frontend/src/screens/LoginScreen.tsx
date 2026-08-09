/**
 * Login screen (Employee Authentication milestone).
 *
 * The application's front door — an internal business tool, not a consumer
 * product, so this stays plain: mark, two fields, one action, a clear error.
 */

import { useState, type FormEvent, type ReactNode } from "react";

import { attemptLogin } from "../auth.js";
import type { Id } from "../fake/types.js";
import { Button, Field, Input } from "../ui/index.js";

export function LoginScreen({ onLogin }: { onLogin: (userId: Id) => void }): ReactNode {
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
      const result = await attemptLogin(username, password);
      if (result.ok) {
        onLogin(result.userId);
      } else {
        setError(result.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-ink-50 px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-sm ring-1 ring-ink-100">
        <div className="mb-6 flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded bg-brand-600 text-sm font-bold text-white">
            AL
          </span>
          <div>
            <p className="text-sm font-semibold text-ink-900">Amaze Operating System</p>
            <p className="text-xs text-ink-500">Sign in with your employee ID</p>
          </div>
        </div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <Field label="Username / Employee ID">
            <Input
              autoFocus
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
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
