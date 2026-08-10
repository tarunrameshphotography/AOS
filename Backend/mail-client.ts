/**
 * Server-side client for the local mail backend (`Backend/mail-server.mjs`),
 * implementing `@domain/communications`' `EmailProvider` from Node.
 *
 * The browser never talks to Gmail directly (see `Frontend/src/fake/mail.ts`'s
 * header) — a real submission send now goes browser -> API server -> this
 * file -> mail-server.mjs -> Gmail, so the refresh token never reaches a
 * browser bundle and every send is behind `submission.create`.
 *
 * A factory rather than only a singleton, so a test can point one call at a
 * scratch mail-server instance without touching the module every other route
 * uses (see Backend/submissions.test.ts).
 */

import type {
  EmailProvider,
  EmailSendResult,
  OutgoingEmail,
} from "@domain/communications/index.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:4320";

/** Bytes to base64. Node has no call-stack limit on `Buffer`, so this needs
 * none of the chunking `Frontend/src/fake/mail.ts`'s `toBase64` does for
 * `btoa` in the browser. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function createHttpEmailProvider(
  baseUrl: string = process.env.AOS_MAIL_SERVER_URL ?? DEFAULT_BASE_URL,
): EmailProvider {
  const url = baseUrl.replace(/\/$/, "");

  return {
    name: "aos-mail-backend",

    async send(email: OutgoingEmail): Promise<EmailSendResult> {
      let response: Response;
      try {
        response = await fetch(`${url}/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            submissionPackageEmailId: email.submissionPackageEmailId,
            from: { email: email.from.email, name: email.from.name },
            to: email.to.map((address) => ({ email: address.email, name: address.name })),
            cc: (email.cc ?? []).map((address) => ({ email: address.email, name: address.name })),
            subject: email.subject,
            body: email.body,
            attachments: email.attachments.map((attachment) => ({
              fileName: attachment.fileName,
              contentType: attachment.contentType,
              base64: toBase64(attachment.bytes),
            })),
          }),
        });
      } catch {
        // The mail backend is not running, or the machine is offline. A
        // transport fault is a typed failure, not a throw: the caller is
        // mid-way through a package and has to record this email as failed
        // and carry on with the rest (ADR-039).
        return {
          ok: false,
          submissionPackageEmailId: email.submissionPackageEmailId,
          failure: {
            kind: "network",
            message: "Could not reach the local mail backend. Nothing was sent.",
          },
        };
      }

      if (!response.ok) {
        return {
          ok: false,
          submissionPackageEmailId: email.submissionPackageEmailId,
          failure: {
            kind: "unknown",
            message: `The mail backend returned HTTP ${response.status}. Nothing was sent.`,
          },
        };
      }

      return (await response.json()) as EmailSendResult;
    },
  };
}

export const emailProvider: EmailProvider = createHttpEmailProvider();
