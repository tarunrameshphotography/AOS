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
