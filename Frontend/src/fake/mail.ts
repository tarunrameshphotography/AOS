/**
 * The frontend's `EmailProvider` — talks to the local mail backend
 * (`Backend/mail-server.mjs`) over HTTP, exactly as `storage.ts` talks to the
 * storage backend.
 *
 * Nothing outside this file knows there is an HTTP hop, and nothing in it
 * knows what Gmail is. Both facts are the point: `store.ts` calls
 * `emailProvider.send(...)` and receives an `EmailSendResult`, which is the
 * same thing it would receive from a Supabase edge function, a Workspace
 * connector or an SMTP relay later.
 *
 * WHY THE BROWSER DOES NOT TALK TO GMAIL DIRECTLY. It would need the refresh
 * token, which would mean shipping a credential for the Amaze Loans mailbox to
 * every machine in the office inside a JavaScript bundle. That is not a
 * configuration mistake to be careful about; it is not a thing that can be
 * done safely at all.
 */

import type {
  EmailProvider,
  EmailSendResult,
  OutgoingEmail,
} from "@domain/communications/index.js";

const BASE_URL =
  (import.meta.env.VITE_MAIL_SERVER_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://127.0.0.1:4320";

/**
 * Bytes to base64, in chunks.
 *
 * `btoa(String.fromCharCode(...bytes))` is the obvious one-liner and it throws
 * on a ten-megabyte attachment — spreading two million arguments overflows the
 * call stack. Chunking is not an optimisation here, it is the difference
 * between working and not.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export interface MailBackendHealth {
  readonly ok: boolean;
  readonly provider: string;
  /** Whether a send would actually reach a mailbox. `false` for the default
   * `unconfigured` provider and for a half-configured Gmail. */
  readonly configured: boolean;
  readonly sender: { readonly address: string; readonly name: string };
  readonly missing?: readonly string[];
}

/**
 * What the backend says about itself.
 *
 * Read for DISPLAY — the send dialog tells the user which mailbox a file is
 * about to go out from, and warns before they press Send if nothing is
 * connected. It is never used as a permission check or as a substitute for the
 * send's own result: a backend that says it is configured can still fail, and
 * only the send knows.
 */
export async function mailBackendHealth(): Promise<MailBackendHealth> {
  const response = await fetch(`${BASE_URL}/health`);
  if (!response.ok) {
    throw new Error("Could not read the mail backend's configuration.");
  }
  return (await response.json()) as MailBackendHealth;
}

class HttpEmailProvider implements EmailProvider {
  readonly name = "aos-mail-backend";

  async send(email: OutgoingEmail): Promise<EmailSendResult> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/send`, {
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
      // The backend is not running, or the machine is offline. A transport
      // fault is returned as a typed failure rather than thrown, because the
      // caller is mid-way through a batch and has to record this email as
      // failed and carry on with the rest (ADR-039).
      return {
        ok: false,
        submissionPackageEmailId: email.submissionPackageEmailId,
        failure: {
          kind: "network",
          message:
            "Could not reach the local mail backend. Is it running (npm run mail-server)? Nothing was sent.",
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
  }
}

export const emailProvider: EmailProvider = new HttpEmailProvider();
