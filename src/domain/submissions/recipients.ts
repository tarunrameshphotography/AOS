/**
 * Who a submission is addressed to, and what the file remembers about where
 * it went.
 *
 * Source of truth: ADR-036. Schema: Database/migrations/0024.
 *
 * Two ideas, and they are the whole of this module:
 *
 *   RECIPIENTS. A file goes to bankers, plural. The relationship manager, the
 *   credit manager who will actually raise the query, and the branch's shared
 *   mailbox so the file does not die when one person is on leave. This module
 *   validates a list of them and normalises it into what gets stored.
 *
 *   SNAPSHOTS. What a bank and branch were CALLED when the file went to them.
 *   Master data is edited — branches are renamed, moved and closed — and an
 *   edit must never rewrite what a historical submission says it did.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO, and must not be extended to do:
 *
 *   Send anything. There is no Gmail here, no Outlook, no SMTP, no draft, no
 *   attachment, no size limit. `recipientKind` records the office's intent
 *   about who is addressed and who is copied, and is read by nothing today.
 *   When an email integration arrives it consumes these shapes; it does not
 *   live in them.
 *
 *   Decide which bank to send to. That is routing, it is a named later
 *   milestone, and ADR-016's warning about confidently wrong answers applies
 *   to it with full force.
 *
 *   Verify that an address is real. `isEmailShaped` catches the mistakes that
 *   actually happen — a name typed into the email box, a missing domain, a
 *   comma left on the end of a pasted list. It is not RFC 5322 and must not
 *   grow into an attempt at it: the only proof an address works is a reply.
 */

// ---------------------------------------------------------------------------
// Shapes.
// ---------------------------------------------------------------------------

/**
 * To, or copied. The one thing about a recipient that a future email
 * integration could not infer and the office genuinely knows: the manager is
 * addressed, the branch mailbox is copied.
 */
export type RecipientKind = "to" | "cc";

/** A banker email address, as the user entered it before it is stored. */
export interface RecipientDraft {
  readonly email: string;
  /** Optional. Many of these are desks — "homeloans.cbe@bank.com" is an
   * address, not a person, and demanding a name for it invites a made-up one. */
  readonly name?: string | undefined;
  readonly designation?: string | undefined;
  /** The catalogue contact this came from, when it came from one. Absent for
   * an address typed in on the spot, which must stay possible or people keep
   * a second list outside the system. */
  readonly bankContactId?: string | undefined;
  readonly kind?: RecipientKind | undefined;
  readonly isPrimary?: boolean | undefined;
}

/** A validated recipient, in the shape that is stored. */
export interface Recipient {
  readonly email: string;
  readonly name?: string | undefined;
  readonly designation?: string | undefined;
  readonly bankContactId?: string | undefined;
  readonly kind: RecipientKind;
  readonly isPrimary: boolean;
  readonly displayOrder: number;
}

/**
 * What a submission remembers about where it went, captured once and never
 * updated.
 *
 * Denormalised on purpose. The live foreign keys are how you reach the branch
 * as it is now; these are what it was called then, and neither can be derived
 * from the other.
 */
export interface SubmissionSnapshot {
  readonly bankName: string;
  readonly branchName: string;
  readonly branchAddress?: string | undefined;
  readonly branchCity?: string | undefined;
  /** ISO timestamp. Its absence means the row was reconstructed rather than
   * recorded — see `submission.snapshot_taken_at` in 0024. */
  readonly takenAt: string;
}

// ---------------------------------------------------------------------------
// Email.
// ---------------------------------------------------------------------------

/**
 * Trimmed and lower-cased. Addresses are compared case-insensitively because
 * that is how mail servers treat the domain and how every provider Amaze
 * deals with treats the local part — and because "Manager@bank.com" and
 * "manager@bank.com" appearing as two recipients on one file is a mistake,
 * not a distinction.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Shaped like an address. Not RFC validation — see this module's header.
 *
 * The same expression as the check constraint on `submission_recipient`
 * (Database/migrations/0024), deliberately: a rule enforced in two places
 * with two definitions is a rule that will disagree with itself.
 */
export function isEmailShaped(email: string): boolean {
  return /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(normaliseEmail(email));
}

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

export type RecipientProblem =
  | { readonly kind: "none_given" }
  | { readonly kind: "malformed"; readonly email: string }
  | { readonly kind: "duplicate"; readonly email: string }
  | { readonly kind: "multiple_primaries" };

export type RecipientResult =
  | { readonly ok: true; readonly recipients: readonly Recipient[] }
  | { readonly ok: false; readonly problem: RecipientProblem };

/**
 * One sentence per problem, in office language, so the same wording appears
 * wherever the check runs — the argument @domain/products makes for keeping
 * presentation beside the rule.
 */
export function describeProblem(problem: RecipientProblem): string {
  switch (problem.kind) {
    case "none_given":
      return "Add at least one banker email address. A bank with nobody to send to is a note, not a submission.";
    case "malformed":
      return `"${problem.email}" does not look like an email address.`;
    case "duplicate":
      return `${problem.email} is listed twice. One address, one line.`;
    case "multiple_primaries":
      return "Only one banker can be the primary contact for a submission.";
  }
}

/**
 * Validate and normalise the addresses a file is going to.
 *
 * The rules, and why each is a rule rather than a warning:
 *
 *   AT LEAST ONE. The workflow this feeds exists to record who a file was
 *   sent to. Zero recipients is the old "Send to Bank" behaviour wearing the
 *   new screen's clothes.
 *
 *   NO DUPLICATES, case-insensitively. A duplicate is never intentional, and
 *   left in it would mean a future email integration addressing one person
 *   twice.
 *
 *   AT MOST ONE PRIMARY. A second primary is a data entry mistake, not a
 *   preference. If none is marked, the FIRST recipient becomes primary rather
 *   than the submission having none — the user typed it first because it is
 *   the one that matters, and a nullable answer here would only be resolved
 *   by guessing later anyway.
 *
 * Order is preserved. The user typed the important address first, and
 * re-sorting it would silently overrule them.
 */
export function validateRecipients(drafts: readonly RecipientDraft[]): RecipientResult {
  const usable = drafts.filter((draft) => draft.email.trim() !== "");
  if (usable.length === 0) return { ok: false, problem: { kind: "none_given" } };

  const seen = new Set<string>();
  for (const draft of usable) {
    const email = normaliseEmail(draft.email);
    if (!isEmailShaped(email)) {
      return { ok: false, problem: { kind: "malformed", email: draft.email.trim() } };
    }
    if (seen.has(email)) return { ok: false, problem: { kind: "duplicate", email } };
    seen.add(email);
  }

  const marked = usable.filter((draft) => draft.isPrimary === true);
  if (marked.length > 1) return { ok: false, problem: { kind: "multiple_primaries" } };
  const primaryEmail = normaliseEmail((marked[0] ?? usable[0]!).email);

  let primaryTaken = false;
  const recipients = usable.map((draft, index): Recipient => {
    const email = normaliseEmail(draft.email);
    const isPrimary = !primaryTaken && email === primaryEmail;
    if (isPrimary) primaryTaken = true;
    const name = blankToUndefined(draft.name);
    const designation = blankToUndefined(draft.designation);
    return {
      email,
      ...(name !== undefined ? { name } : {}),
      ...(designation !== undefined ? { designation } : {}),
      ...(draft.bankContactId !== undefined ? { bankContactId: draft.bankContactId } : {}),
      kind: draft.kind ?? "to",
      isPrimary,
      displayOrder: (index + 1) * 10,
    };
  });

  return { ok: true, recipients };
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// Presentation.
//
// Here rather than in the screen because a submission's counterparty reads
// the same on a case, in a report and in a future AI summary, and three
// slightly different renderings of it is how a system stops sounding like one
// system (the argument @domain/lenders makes for turnaround).
// ---------------------------------------------------------------------------

/**
 * The counterparty, as one line: "Indian Bank — RS Puram".
 *
 * Reads the SNAPSHOT, never the live master data. A branch renamed last month
 * must not change what a file sent in March says it did — which is the entire
 * reason the snapshot exists, and would be quietly undone by a display helper
 * that reached for the current name because it was easier to hand.
 */
export function describeCounterparty(snapshot: SubmissionSnapshot): string {
  if (snapshot.branchName.startsWith(snapshot.bankName)) return snapshot.branchName;
  return `${snapshot.bankName} — ${snapshot.branchName}`;
}

/** "3 bankers", "1 banker", "Nobody addressed". */
export function describeRecipientCount(count: number): string {
  if (count === 0) return "Nobody addressed";
  return `${count} ${count === 1 ? "banker" : "bankers"}`;
}

/**
 * A recipient as a person would write it on an envelope: "Suresh K
 * (Branch Manager) — suresh.k@bank.com", collapsing gracefully when the name
 * or the designation is absent, which for a shared mailbox is normal rather
 * than incomplete.
 */
export function describeRecipient(recipient: Recipient): string {
  const label = recipient.name;
  if (label === undefined) return recipient.email;
  const title = recipient.designation === undefined ? "" : ` (${recipient.designation})`;
  return `${label}${title} — ${recipient.email}`;
}

/** The primary banker, or the first one if somehow none is marked. */
export function primaryRecipient(
  recipients: readonly Recipient[],
): Recipient | undefined {
  return recipients.find((recipient) => recipient.isPrimary) ?? recipients[0];
}
