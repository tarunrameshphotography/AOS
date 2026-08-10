/**
 * The database connection for the AOS backend.
 *
 * One pool for the process. Connection settings come from the environment
 * only (`.env`, git-ignored) and nothing here is prefixed VITE_, so no
 * connection detail can reach the browser bundle.
 *
 * WHAT LIVES HERE AND WHAT DOES NOT: operational metadata — customers, cases,
 * requirements, verification, submissions, users, events. Document BYTES do
 * not. They stay on disk under `AOS_STORAGE_ROOT`, reached through
 * `Backend/storage-server.mjs`, and the database holds only the storage path
 * (see `document.file_path`'s column comment in migration 0005). That split is
 * deliberate and predates this milestone; nothing here changes it.
 */

import pg from "pg";
import { loadDotEnv } from "./env.mjs";

loadDotEnv();

const DATABASE = process.env.AOS_DB_NAME ?? "aos";

/**
 * A backend process may be told which database it is REQUIRED to be talking to,
 * and refuses to start against any other one.
 *
 * WHAT THIS PREVENTS (Stage 3C-0). The Playwright suite creates customers,
 * opens cases, deactivates users and resets passwords. It is supposed to do
 * all of that against `aos_e2e`. Before this guard, the only thing standing
 * between it and the OFFICE database was a `AOS_DB_NAME` set on a server
 * process that Playwright might or might not have started itself — and with
 * `reuseExistingServer` it frequently did not. An office dev server left
 * running on the same port was silently adopted, complete with its connection
 * to `aos`, and the suite happily administered real employee accounts.
 *
 * A misconfiguration must fail at startup, loudly, rather than succeed against
 * the wrong data. Nothing in the office environment sets this variable, so
 * ordinary development is unaffected.
 */
const required = process.env.AOS_REQUIRE_DB_NAME;
if (required !== undefined && required !== DATABASE) {
  throw new Error(
    `Refusing to start: AOS_REQUIRE_DB_NAME is "${required}" but this process would ` +
      `connect to "${DATABASE}". Something is pointing a test at the wrong database.`,
  );
}

export const pool = new pg.Pool({
  host: process.env.AOS_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.AOS_DB_PORT ?? 5432),
  database: DATABASE,
  user: process.env.AOS_DB_USER ?? "postgres",
  password: process.env.AOS_DB_PASSWORD ?? "",
  // The office runs a handful of PCs against one backend. A small pool keeps
  // `app.allocate_case_number`'s per-year row lock (ADR-024) from queueing
  // behind connections doing nothing.
  max: 10,
});

export type Queryable = Pick<pg.PoolClient, "query">;

/**
 * A pool for the ADMINISTRATIVE scripts, which are not the application.
 *
 * WHY THIS IS SEPARATE (Stage 4 Item 3). `aos_app` — the role the API server
 * connects as from migration 0033 — is deliberately not allowed to do what
 * `seed-users.ts` and `bootstrap-production.ts` do. It has no INSERT on
 * `permission` or `role_permission`, and the tier-B RLS policy on `event`
 * refuses a transaction with no authenticated identity, which is exactly what
 * a bootstrap is: there is nobody signed in, because creating the first
 * account is what makes signing in possible.
 *
 * That is the correct answer, not an obstacle to work around. Standing up
 * accounts is an owner's job, done at a console, once. Widening the running
 * API's privileges so a script it never calls can share its connection would
 * trade a real boundary for a small convenience.
 *
 * So: if AOS_DB_ADMIN_USER is set, these scripts use it. If it is not, they
 * fall back to the ordinary pool — which is what happens on a development
 * machine that still connects as `postgres`, and means nothing about this
 * changes until an office actually switches AOS_DB_USER to `aos_app`.
 */
let admin: pg.Pool | null = null;

export function adminPool(): pg.Pool {
  const user = process.env.AOS_DB_ADMIN_USER?.trim();
  if (!user) return pool;
  admin ??= new pg.Pool({
    host: process.env.AOS_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.AOS_DB_PORT ?? 5432),
    database: DATABASE,
    user,
    password: process.env.AOS_DB_ADMIN_PASSWORD ?? process.env.AOS_DB_PASSWORD ?? "",
    // One script, one connection at a time. Nothing here is concurrent.
    max: 2,
  });
  return admin;
}

/** `withActor`, on whichever pool the administrative scripts should use. */
export async function withAdmin<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return await runInTransaction(adminPool(), null, fn);
}

/** Close whatever the admin scripts opened, including the shared pool when
 * AOS_DB_ADMIN_USER was never set and `adminPool()` handed back `pool`. */
export async function closeAdminPool(): Promise<void> {
  if (admin) {
    await admin.end();
    admin = null;
  }
  await pool.end();
}

/**
 * Run `fn` inside a transaction, with the actor's identity published to
 * Postgres for the duration of it.
 *
 * `set_config(..., true)` is TRANSACTION-local — the third argument is the
 * load-bearing one. A session-local setting would outlive the request and,
 * because this is a pool, the next request to borrow that same physical
 * connection would inherit the previous employee's identity. That is a
 * cross-user data leak that presents as a permissions bug and only reproduces
 * under concurrency.
 *
 * `auth.uid()` (migration 0010) reads this setting, and `app.current_user_id()`
 * reads `auth.uid()`. Nothing depends on it yet — authorization is enforced in
 * `authorize.ts` above the query, because 0010 ships RLS with zero policies by
 * design. Publishing the identity anyway means the policy work, when it lands,
 * needs no change here and can be verified against a backend that has been
 * setting it correctly all along.
 */
export async function withActor<T>(
  authIdentityId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return await runInTransaction(pool, authIdentityId, fn);
}

/** The body of `withActor`, parameterised by pool so `withAdmin` can reuse it
 * without duplicating the rollback handling below — which is the part it would
 * be easiest to get subtly wrong in a second copy. */
async function runInTransaction<T>(
  target: pg.Pool,
  authIdentityId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await target.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.auth_identity_id', $1, true)", [
      authIdentityId ?? "",
    ]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    // The rollback must not be able to replace the error that caused it. When
    // PostgreSQL has gone away mid-request, `rollback` fails too — and the
    // rollback's failure is the less informative of the two, so letting it
    // propagate would lose the original cause and, with it, any chance for the
    // caller to classify what actually happened (`isDatabaseUnavailable`).
    try {
      await client.query("rollback");
    } catch {
      // Nothing to do: the transaction is already gone with the connection.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
