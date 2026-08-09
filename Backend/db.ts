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

export const pool = new pg.Pool({
  host: process.env.AOS_DB_HOST ?? "127.0.0.1",
  port: Number(process.env.AOS_DB_PORT ?? 5432),
  database: process.env.AOS_DB_NAME ?? "aos",
  user: process.env.AOS_DB_USER ?? "postgres",
  password: process.env.AOS_DB_PASSWORD ?? "",
  // The office runs a handful of PCs against one backend. A small pool keeps
  // `app.allocate_case_number`'s per-year row lock (ADR-024) from queueing
  // behind connections doing nothing.
  max: 10,
});

export type Queryable = Pick<pg.PoolClient, "query">;

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
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.auth_identity_id', $1, true)", [
      authIdentityId ?? "",
    ]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
