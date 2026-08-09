/**
 * How AOS talks to the outside world (ADR-039).
 *
 * Two seams, deliberately unlike each other:
 *
 * - `email-provider.ts`    — one message at a time, attachments, typed
 *                            failures. Implemented by Gmail today.
 * - `whatsapp-provider.ts` — pre-approved templates, no attachments, no
 *                            implementation yet and a written list of what
 *                            would be needed for one.
 *
 * Nothing above this layer knows which provider is in use, and nothing in the
 * case or document workflow contains provider-specific code.
 */

export {
  describeEmailFailure,
  unconfiguredEmailProvider,
  type EmailAddress,
  type EmailAttachment,
  type EmailFailureKind,
  type EmailProvider,
  type EmailSendFailure,
  type EmailSendResult,
  type OutgoingEmail,
} from "./email-provider.js";

export {
  WHATSAPP_REQUIRED_CONFIGURATION,
  WHATSAPP_SUITABLE_WORKFLOWS,
  WHATSAPP_UNSUITABLE_WORKFLOWS,
  unconfiguredWhatsAppProvider,
  type WhatsAppFailureKind,
  type WhatsAppProvider,
  type WhatsAppRecipient,
  type WhatsAppSendFailure,
  type WhatsAppSendResult,
  type WhatsAppTemplateMessage,
} from "./whatsapp-provider.js";
