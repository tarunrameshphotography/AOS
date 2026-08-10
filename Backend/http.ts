/**
 * The one error type handlers raise to choose a status code.
 *
 * Extracted in Stage 3B because there are now four handler modules
 * (`users`, `customers`, `cases`, `reference`) and the alternative was each
 * importing an error class from `api-server.ts`, which imports all of them —
 * a cycle for the sake of two fields.
 *
 * Every message is written to be shown to an employee. Nothing here ever
 * carries a driver message, a table name or a column name: those go to the
 * server log, and the browser gets a sentence a person can act on.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Refusal text. Deliberately names the missing permission — an employee who
 * cannot act needs to be able to tell their manager what to grant — and
 * deliberately says nothing about whether the row exists. */
export function refusalMessage(permission: string): string {
  return `You do not have permission to do that (${permission}).`;
}

/**
 * Is this failure "the database is not reachable" rather than "the query was
 * wrong"?
 *
 * WHY IT MATTERS (Stage 4 audit, area 6). Both used to arrive at the same
 * place: the catch-all in `api-server.ts`, which logs the driver error and
 * returns 500 "Something went wrong. Please try again." For a genuine bug
 * that is right — an employee can do nothing about it and the details belong
 * in the log, not the browser. For a stopped PostgreSQL service it is
 * actively misleading: the employee retries, gets the same sentence, and the
 * office concludes AOS is broken when the actual answer is "start the
 * database service on the server PC".
 *
 * Matched on node-postgres/libpq error codes rather than message text, which
 * is localised and version-dependent. `ECONNREFUSED` is a stopped server,
 * `ENOTFOUND`/`EHOSTUNREACH` a wrong or unreachable AOS_DB_HOST,
 * `ETIMEDOUT`/`ECONNRESET` a network that dropped mid-query, `57P03` is
 * Postgres itself saying it is still starting up, and `53300` is the
 * connection limit — a real office condition when something leaks connections.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ETIMEDOUT", "ECONNRESET", "EPIPE", "57P03", "53300", "08006", "08001", "08004"].includes(
      code,
    )
  );
}

/** What an employee is told when the database cannot be reached. Names the
 * server rather than the driver: the action is "tell whoever looks after the
 * office server PC", and no table, column or connection string appears. */
export const DATABASE_UNAVAILABLE_MESSAGE =
  "AOS cannot reach its database right now, so nothing was saved. This is a problem " +
  "with the office server, not with what you did. Wait a moment and try again — if it " +
  "keeps happening, the AOS server PC needs attention.";
