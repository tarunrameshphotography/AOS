/**
 * The seam between AOS and whatever actually sends mail.
 *
 * Source of truth: ADR-039.
 *
 * WHAT THIS INTERFACE IS FOR. The submission domain knows a recipient, a
 * subject, a body, some attachments and which submission they belong to. It
 * must not know that Gmail wants an RFC 5322 message base64url-encoded into a
 * JSON field, that the access token expires in an hour, or that the upload
 * endpoint differs from the send endpoint. Every one of those is a fact about
 * one provider in one year.
 *
 *   AOS submission domain
 *           ↓
 *     EmailProvider          ← this file
 *           ↓
 *   Gmail / Workspace        ← Backend/mail-server.mjs
 *
 * Microsoft 365, plain SMTP or an enterprise gateway would each implement this
 * same interface. NONE OF THEM IS IMPLEMENTED NOW, deliberately: an
 * abstraction with one implementation is an honest seam, and an abstraction
 * with three speculative ones is a framework nobody asked for.
 *
 * WHY FAILURE IS A TYPED VALUE AND NOT AN EXCEPTION. A submission of eight
 * documents across three emails can succeed twice and fail once, and the user
 * has to be told exactly that (this milestone says so in as many words). An
 * exception collapses "the third one failed" into "it failed", and the
 * recovery — resend only the third — becomes unavailable. So the provider
 * returns a result per message, and only a genuinely unexpected fault throws.
 */

/** An address, with the display name where one is known. */
export interface EmailAddress {
  readonly email: string;
  readonly name?: string | undefined;
}

export interface EmailAttachment {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/**
 * One message, ready to send.
 *
 * `submissionPackageEmailId` travels with it so that a provider response — or
 * a failure — can be recorded against the exact row it belongs to. Without it
 * a retry cannot tell which of three emails came back, which is how a banker
 * ends up with the same attachments twice.
 */
export interface OutgoingEmail {
  readonly submissionPackageEmailId: string;
  readonly from: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly cc?: readonly EmailAddress[] | undefined;
  readonly subject: string;
  /** Plain text. AOS sends no HTML mail — see compose.ts. */
  readonly body: string;
  readonly attachments: readonly EmailAttachment[];
}

/**
 * Why a send failed, in the categories a user or an operator can act on.
 *
 * Each one has a different next step, which is the entire reason they are
 * distinguished: an invalid address is fixed by editing it, an authentication
 * failure by an administrator reconnecting the mailbox, a network failure by
 * pressing Retry, and a provider rejection by reading what the provider said.
 */
export type EmailFailureKind =
  | "invalid_recipient"
  | "not_configured"
  | "authentication"
  | "network"
  | "timeout"
  | "attachment_too_large"
  | "rejected_by_provider"
  | "unknown";

export interface EmailSendFailure {
  readonly kind: EmailFailureKind;
  /** The provider's own words where it gave any. Shown, never replaced with
   * "something went wrong" — the same reasoning as the toast in ui/index.tsx. */
  readonly message: string;
}

export type EmailSendResult =
  | {
      readonly ok: true;
      readonly submissionPackageEmailId: string;
      /** The provider's own id for the sent message, where it returns one.
       * Recorded so a message can be found again in the sent mailbox. */
      readonly providerMessageId?: string | undefined;
      readonly sentAt: string;
    }
  | {
      readonly ok: false;
      readonly submissionPackageEmailId: string;
      readonly failure: EmailSendFailure;
    };

/**
 * How AOS sends one email.
 *
 * ONE MESSAGE PER CALL, deliberately. A batch call would have to define what
 * happens when three of five succeed, which is exactly the partial-failure
 * problem this milestone requires be visible — so it stays visible, one result
 * at a time, in the caller's own loop.
 */
export interface EmailProvider {
  /** A stable name for the audit record: "gmail", "capture", "unconfigured". */
  readonly name: string;
  send(email: OutgoingEmail): Promise<EmailSendResult>;
}

/** One sentence per failure kind, in office language. */
export function describeEmailFailure(failure: EmailSendFailure): string {
  switch (failure.kind) {
    case "invalid_recipient":
      return `The address was refused: ${failure.message}`;
    case "not_configured":
      return (
        "AOS is not connected to a mailbox yet, so nothing was sent. " +
        "An administrator needs to connect the Amaze Loans mailbox — see Docs/Email and WhatsApp Integration.md."
      );
    case "authentication":
      return (
        "The mailbox connection was rejected. The authorisation has probably expired or been revoked — " +
        "an administrator needs to reconnect it. Nothing was sent."
      );
    case "network":
      return "Could not reach the mail provider. Nothing was sent — press Retry once the connection is back.";
    case "timeout":
      return "The mail provider did not answer in time. This email may or may not have gone out — check the sent mailbox before retrying.";
    case "attachment_too_large":
      return `The provider refused the attachments as too large: ${failure.message}`;
    case "rejected_by_provider":
      return `The mail provider refused this email: ${failure.message}`;
    case "unknown":
      return failure.message;
  }
}

/**
 * The provider AOS uses when nothing is configured.
 *
 * IT REFUSES. It does not pretend, does not queue, does not log-and-continue.
 * A prototype that quietly "sends" mail nobody receives is worse than one that
 * cannot send at all, because the case timeline would record a submission that
 * never happened and somebody would stop chasing the bank.
 */
export const unconfiguredEmailProvider: EmailProvider = {
  name: "unconfigured",
  async send(email: OutgoingEmail): Promise<EmailSendResult> {
    return {
      ok: false,
      submissionPackageEmailId: email.submissionPackageEmailId,
      failure: {
        kind: "not_configured",
        message: "No email provider is configured for this installation of AOS.",
      },
    };
  },
};
