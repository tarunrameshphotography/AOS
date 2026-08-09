/**
 * Which documents may be sent to a banker, and how large an email may get.
 *
 * Source of truth: ADR-039. Schema: Database/migrations/0030.
 *
 * Two questions, and they are the whole of this module.
 *
 *   WHAT IS SENDABLE. A verified document, and nothing else. Not a missing
 *   requirement, not one sitting unread, not one a reviewer rejected, not a
 *   waiver. A file that goes to a bank is a representation by Amaze that
 *   somebody looked at these papers, and BR-032 says that somebody is always
 *   a named human. A pending row has no such name on it.
 *
 *   HOW BIG AN EMAIL MAY BE. The office rule is ten megabytes of attachments
 *   per email. That number is not arbitrary and it is not merely a
 *   provider limit copied down — see the ceiling section below.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not read bytes, know
 * about storage, know about Gmail, or decide which bank a file goes to. It
 * takes facts a caller has already resolved and answers questions about them,
 * which is what makes every rule in here testable without a network, a disk
 * or a credential.
 */

// ---------------------------------------------------------------------------
// The ceiling, and why it is where it is.
// ---------------------------------------------------------------------------

/**
 * The AOS rule: no individual outgoing email may carry more than ten
 * megabytes of attachments.
 *
 * Binary megabytes, matching how `bytes()` renders a file size on screen — a
 * user told "9.7 MB" by the review screen and refused at 10 MB by the system
 * would otherwise be looking at two different megabytes.
 */
export const MAX_ATTACHMENT_BYTES_PER_EMAIL = 10 * 1024 * 1024;

/**
 * Gmail's own limit on a single message, attachments included.
 *
 * Recorded here because the AOS rule has to be provably BELOW it rather than
 * hopefully below it. Gmail rejects a message above this at the API, which
 * would surface as a provider rejection on a send the user had already
 * confirmed — the worst moment to discover a size problem.
 */
export const GMAIL_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * MIME headroom: headers, the multipart boundaries, the body, and the
 * per-attachment `Content-Disposition` lines.
 *
 * Generous on purpose. It is a margin, not a measurement, and the only way it
 * can hurt is by making AOS slightly more cautious than it strictly needs to
 * be about a limit it is nowhere near.
 */
export const MIME_OVERHEAD_BYTES = 64 * 1024;

/**
 * What `n` raw bytes weigh once base64-encoded into a MIME part.
 *
 * Base64 turns every 3 bytes into 4 characters, and RFC 2045 requires the
 * result be wrapped at 76 characters with CRLF line endings. Both are counted:
 * the wrapping alone is another ~2.6%, which is small until it is the thing
 * standing between a message and a provider limit.
 *
 * This is the calculation that makes "10 MB is safe" a checked claim rather
 * than an assumption — see the assertion in attachments.test.ts.
 */
export function base64EncodedSize(rawBytes: number): number {
  const characters = Math.ceil(rawBytes / 3) * 4;
  const lines = Math.ceil(characters / 76);
  return characters + lines * 2;
}

/**
 * Would an email carrying `rawAttachmentBytes` fit inside the provider's own
 * message limit, once encoded?
 *
 * Answered against Gmail because Gmail is the provider being configured
 * (ADR-039). A future provider with a smaller limit passes its own.
 */
export function fitsProviderMessageLimit(
  rawAttachmentBytes: number,
  providerMaxMessageBytes: number = GMAIL_MAX_MESSAGE_BYTES,
): boolean {
  return base64EncodedSize(rawAttachmentBytes) + MIME_OVERHEAD_BYTES <= providerMaxMessageBytes;
}

// ---------------------------------------------------------------------------
// What a candidate document looks like to this layer.
// ---------------------------------------------------------------------------

/**
 * One document offered for submission, as the domain needs to see it.
 *
 * Ids rather than rows, and a document TYPE CODE rather than a type id: this
 * module is pure and has no database to resolve an id against, and a code is
 * what the batching and composition rules below actually reason about
 * (the same argument @domain/products makes for codes over ids).
 */
export interface CandidateDocument {
  readonly documentId: string;
  /** The requirement this satisfies. Present for a checklist row; absent for
   * a document reached some other way, which nothing does today. */
  readonly requirementId?: string | undefined;
  readonly documentTypeCode: string;
  /** What the row is called on screen, period included — "GST 3B – FY 2025-26". */
  readonly label: string;
  readonly fileName: string;
  readonly fileSizeBytes: number;
  /** The checklist's own section, used as the fallback grouping. */
  readonly category: string;
  /** "2024-25" for a financial-year-scoped document. Undefined otherwise. */
  readonly financialYearLabel?: string | undefined;
  /** Version number (BR-031). Recorded on the package so the submission
   * identifies the version actually transmitted, not just the document. */
  readonly version: number;
  /** ISO timestamp. Its presence is what makes the document sendable. */
  readonly verifiedAt?: string | undefined;
  readonly rejectedAt?: string | undefined;
}

/**
 * Why a document may not be sent. One case per reason, because "not eligible"
 * on a screen tells a user nothing they can act on.
 */
export type IneligibilityReason =
  | { readonly kind: "not_verified" }
  | { readonly kind: "rejected" }
  | { readonly kind: "too_large"; readonly fileSizeBytes: number; readonly limitBytes: number };

/**
 * May this document be attached to an outgoing email?
 *
 * Returns the reason it may not, or `undefined` when it may — so a caller
 * reads as `const reason = ineligibility(doc); if (reason) …`, the same shape
 * as the store's `authorize()` guards.
 *
 * ORDER MATTERS. Rejection is reported ahead of size because a rejected
 * document is not going out at any size, and telling somebody their rejected
 * file is too large invites them to shrink it.
 */
export function ineligibility(
  document: CandidateDocument,
  limitBytes: number = MAX_ATTACHMENT_BYTES_PER_EMAIL,
): IneligibilityReason | undefined {
  if (document.rejectedAt !== undefined) return { kind: "rejected" };
  if (document.verifiedAt === undefined) return { kind: "not_verified" };
  if (document.fileSizeBytes > limitBytes) {
    return { kind: "too_large", fileSizeBytes: document.fileSizeBytes, limitBytes };
  }
  return undefined;
}

export function isSendable(
  document: CandidateDocument,
  limitBytes: number = MAX_ATTACHMENT_BYTES_PER_EMAIL,
): boolean {
  return ineligibility(document, limitBytes) === undefined;
}

/**
 * One sentence per reason, in office language.
 *
 * Beside the rule rather than in the screen, for the reason `recipients.ts`
 * keeps `describeProblem` beside `validateRecipients`: the same refusal has to
 * read identically in the selection list, in the review screen and in a toast.
 *
 * The oversized message names a NEXT ACTION. "Too large" alone leaves a user
 * holding a document the system will not send and no idea what to do with it,
 * which is how a document ends up going out from somebody's personal mailbox.
 */
export function describeIneligibility(reason: IneligibilityReason): string {
  switch (reason.kind) {
    case "not_verified":
      return "Not verified yet. Only a document a person has checked goes to a bank (BR-032).";
    case "rejected":
      return "Rejected on review. Ask the customer for a replacement, verify it, then send.";
    case "too_large":
      return (
        `${megabytes(reason.fileSizeBytes)} — over the ${megabytes(reason.limitBytes)} limit for one email. ` +
        "Ask the customer for a smaller scan, or split the document and upload the parts as separate " +
        "requirements. AOS will not shrink it for you: a compressed bank statement is not the document " +
        "the customer signed."
      );
  }
}

/** "10.0 MB", matching how the case screen renders a file size. */
function megabytes(size: number): string {
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
