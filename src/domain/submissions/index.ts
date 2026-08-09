/**
 * The bank submission workflow (Milestone 10, ADR-036) and sending its
 * documents to the banker (ADR-039).
 *
 * One entry point, matching @domain/lenders, @domain/products and
 * @domain/requirements, so a consumer imports what a submission means rather
 * than which file it lives in.
 *
 * Five files, one job each:
 *
 * - `recipients.ts`  — who a file is addressed to, and what it remembers about
 *                       where it went.
 * - `attachments.ts` — which documents may be sent, and how large one email
 *                       may be.
 * - `batching.ts`    — splitting a selection across emails, deterministically.
 * - `compose.ts`     — the subject and the body, written from AOS's own facts.
 * - `package.ts`     — the three above, composed into the object the user
 *                       reviews and the sender walks.
 *
 * Nothing in any of them reads bytes, touches a network or knows what Gmail
 * is. Sending lives behind @domain/communications' `EmailProvider`.
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

export {
  GMAIL_MAX_MESSAGE_BYTES,
  MAX_ATTACHMENT_BYTES_PER_EMAIL,
  MIME_OVERHEAD_BYTES,
  base64EncodedSize,
  describeIneligibility,
  fitsProviderMessageLimit,
  ineligibility,
  isSendable,
  type CandidateDocument,
  type IneligibilityReason,
} from "./attachments.js";

export {
  ATTACHMENT_GROUPS,
  ATTACHMENT_GROUP_PHRASE,
  compareForBatching,
  describeGroups,
  groupOf,
  groupProse,
  groupsIn,
  joinWithAmpersand,
  planBatches,
  type AttachmentBatch,
  type AttachmentGroup,
  type BatchPlanProblem,
  type BatchPlanResult,
} from "./batching.js";

export {
  composeBody,
  composeGreeting,
  composeSubject,
  describeContents,
  describeSubmissionForTimeline,
  numberWord,
  type BankerRecipient,
  type EmailSender,
  type SubmissionContext,
} from "./compose.js";

export {
  describePackageProblem,
  documentIdsIn,
  planSubmissionPackage,
  type PackagePlanInput,
  type PackagePlanProblem,
  type PackagePlanResult,
  type PlannedEmail,
  type SubmissionPackagePlan,
} from "./package.js";
