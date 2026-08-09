/**
 * The seam between AOS and WhatsApp Business.
 *
 * Source of truth: ADR-039.
 *
 * READ THIS BEFORE EXTENDING THE FILE. Nothing here sends a WhatsApp message,
 * and the absence is the design rather than an unfinished corner.
 *
 * WHATSAPP IS NOT THE BANKER CHANNEL. The email workflow this milestone builds
 * sends a bank ten megabytes of scanned title deeds with a subject line a
 * credit manager files against a customer. WhatsApp does none of that well: a
 * document message carries one file at a time, there is no subject, no cc, no
 * threading a colleague can be added to, and the whole conversation lives on
 * one person's handset rather than in a branch mailbox. Forcing the email
 * architecture onto it would produce a worse version of something that already
 * works, which is why this file shares no shapes with `email-provider.ts`
 * beyond the ones that are genuinely the same idea.
 *
 * WHAT WHATSAPP IS ACTUALLY FOR HERE — the CUSTOMER side, where email is the
 * weak channel and WhatsApp is the one people in Coimbatore actually read:
 *
 *   - "Here is what we still need from you", with the checklist.
 *   - A reminder on a document that has been outstanding for a week.
 *   - "Your file went to HDFC Bank today."
 *   - Appointment and follow-up confirmations.
 *
 * All four are business-initiated messages outside any 24-hour service window,
 * which under Meta's rules means every one of them is a PRE-APPROVED TEMPLATE
 * with positional parameters — not free text. That constraint shapes the
 * interface below entirely, and it is the single most common thing to get
 * wrong when this is built: an interface that accepts a `body: string` cannot
 * be implemented against the real API.
 *
 * WHAT IS FORBIDDEN, PERMANENTLY. WhatsApp Web automation, browser scraping,
 * QR-session hijacking and every "personal WhatsApp" library. They breach
 * Meta's terms, they get the number banned — the office's actual working
 * number — and they cannot be audited. The only acceptable implementation is
 * the WhatsApp Business Cloud API (or a BSP reselling it).
 */

/** A phone number in E.164, which is the only form the Cloud API accepts. */
export interface WhatsAppRecipient {
  /** "+919843100000". Country code required — a bare ten-digit number is
   * rejected by the API and there is nothing sensible to assume. */
  readonly phoneE164: string;
  readonly name?: string | undefined;
}

/**
 * A message, as a template invocation.
 *
 * `templateName` and `languageCode` name something already approved inside the
 * Meta Business account; `parameters` fills its positional placeholders in
 * order. There is deliberately no free-text field: a business-initiated
 * WhatsApp message cannot be free text, and offering one here would produce an
 * interface that compiles and then fails at the provider on every call.
 */
export interface WhatsAppTemplateMessage {
  readonly messageId: string;
  readonly to: WhatsAppRecipient;
  readonly templateName: string;
  /** "en" / "en_US" / "ta" — the approved template's own language. */
  readonly languageCode: string;
  readonly parameters: readonly string[];
}

export type WhatsAppFailureKind =
  | "not_configured"
  | "invalid_recipient"
  | "template_not_approved"
  | "outside_service_window"
  | "authentication"
  | "network"
  | "rejected_by_provider"
  | "unknown";

export interface WhatsAppSendFailure {
  readonly kind: WhatsAppFailureKind;
  readonly message: string;
}

export type WhatsAppSendResult =
  | { readonly ok: true; readonly messageId: string; readonly providerMessageId?: string | undefined; readonly sentAt: string }
  | { readonly ok: false; readonly messageId: string; readonly failure: WhatsAppSendFailure };

export interface WhatsAppProvider {
  readonly name: string;
  send(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult>;
}

/**
 * Everything an administrator must obtain before a WhatsApp provider can be
 * implemented against this seam.
 *
 * Written down here rather than in a ticket because the honest answer to "why
 * is WhatsApp not working?" is this list, and it should be readable from the
 * code that would consume it. None of it is a credential AOS can create for
 * itself; all of it requires a person with access to a Meta Business account.
 */
export const WHATSAPP_REQUIRED_CONFIGURATION: readonly {
  readonly key: string;
  readonly what: string;
}[] = [
  {
    key: "Meta Business Account",
    what: "A verified Meta Business account for Amaze Loans Pvt Ltd. Business verification requires company documents and takes days, not minutes.",
  },
  {
    key: "WhatsApp Business Account (WABA)",
    what: "Created inside the Meta Business account, with a phone number registered to it. That number can no longer be used with the ordinary WhatsApp or WhatsApp Business handset apps.",
  },
  {
    key: "AOS_WHATSAPP_PHONE_NUMBER_ID",
    what: "The Cloud API's id for the registered sending number. Not the phone number itself.",
  },
  {
    key: "AOS_WHATSAPP_ACCESS_TOKEN",
    what: "A system-user access token with whatsapp_business_messaging. A temporary developer token expires in 24 hours and must not be used for anything real.",
  },
  {
    key: "Approved message templates",
    what: "One per workflow (document request, reminder, status update, appointment). Each is submitted to Meta and reviewed. Business-initiated messages cannot be sent without one.",
  },
  {
    key: "Webhook endpoint",
    what: "A public HTTPS callback for delivery receipts and customer replies. AOS has no public endpoint today — the local backend is bound to 127.0.0.1.",
  },
  {
    key: "Customer consent record",
    what: "Opt-in, captured and stored per customer. Meta requires it and Indian data-protection practice expects it. AOS has no field for this yet.",
  },
];

/** The workflows WhatsApp is the right channel for, and the one it is not. */
export const WHATSAPP_SUITABLE_WORKFLOWS: readonly string[] = [
  "Customer document requests — the outstanding checklist, sent to the applicant.",
  "Missing-document reminders — one document, chased after a few days.",
  "Case status updates — 'your file has gone to the bank', 'the bank has sanctioned'.",
  "Appointment and follow-up confirmations.",
];

export const WHATSAPP_UNSUITABLE_WORKFLOWS: readonly string[] = [
  "Sending documents to a banker. That is the email workflow: bankers work in mailboxes, a submission needs a subject and a cc, and ten megabytes of attachments is not a WhatsApp interaction.",
];

/**
 * The provider AOS uses until the configuration above exists. It refuses, for
 * the same reason `unconfiguredEmailProvider` refuses: a recorded send that
 * did not happen is worse than an obvious failure.
 */
export const unconfiguredWhatsAppProvider: WhatsAppProvider = {
  name: "unconfigured",
  async send(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult> {
    return {
      ok: false,
      messageId: message.messageId,
      failure: {
        kind: "not_configured",
        message:
          "WhatsApp Business is not connected. " +
          `Required first: ${WHATSAPP_REQUIRED_CONFIGURATION.map((entry) => entry.key).join(", ")}.`,
      },
    };
  },
};
