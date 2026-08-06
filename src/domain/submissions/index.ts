/**
 * The bank submission workflow (Milestone 10, ADR-036).
 *
 * One entry point, matching @domain/lenders, @domain/products and
 * @domain/requirements, so a consumer imports what a submission means rather
 * than which file it lives in.
 */

export {
  describeCounterparty,
  describeProblem,
  describeRecipient,
  describeRecipientCount,
  isEmailShaped,
  normaliseEmail,
  primaryRecipient,
  validateRecipients,
  type Recipient,
  type RecipientDraft,
  type RecipientKind,
  type RecipientProblem,
  type RecipientResult,
  type SubmissionSnapshot,
} from "./recipients.js";
