/**
 * A submission package: the documents chosen for one banker, split into the
 * emails they will be sent as, with every subject and body already written.
 *
 * Source of truth: ADR-039. Schema: Database/migrations/0030.
 *
 * This is the object the user reviews before pressing Send, and it is the same
 * object the sender walks. That identity is the point: a review screen that
 * shows one thing and a sender that computes another is a review screen that
 * lies, and this is the last confirmation before customer documents leave the
 * building.
 *
 * Everything here is pure. No bytes, no network, no clock, no storage — a plan
 * is computed, asserted against in tests, rendered on screen and only then
 * handed to something that can actually send. `attachments`, `batching` and
 * `compose` each answer one question; this composes the three into the single
 * answer the rest of AOS asks for.
 */

import {
  MAX_ATTACHMENT_BYTES_PER_EMAIL,
  describeIneligibility,
  fitsProviderMessageLimit,
  type CandidateDocument,
} from "./attachments.js";
import { planBatches, type AttachmentGroup, type BatchPlanProblem } from "./batching.js";
import {
  composeBody,
  composeSubject,
  type BankerRecipient,
  type EmailSender,
  type SubmissionContext,
} from "./compose.js";
import {
  describeProblem,
  validateRecipients,
  type RecipientDraft,
  type RecipientProblem,
} from "./recipients.js";

/** One outgoing email, complete except for the bytes. */
export interface PlannedEmail {
  /** 1-based, and the number the subject says: "(2/3)". */
  readonly sequence: number;
  readonly subject: string;
  readonly body: string;
  readonly documents: readonly CandidateDocument[];
  readonly totalBytes: number;
  readonly groups: readonly AttachmentGroup[];
}

export interface SubmissionPackagePlan {
  readonly emails: readonly PlannedEmail[];
  readonly to: readonly BankerRecipient[];
  readonly cc: readonly BankerRecipient[];
  readonly documentCount: number;
  readonly totalBytes: number;
  readonly sender: EmailSender;
  readonly context: SubmissionContext;
}

export type PackagePlanProblem =
  | BatchPlanProblem
  | { readonly kind: "recipients"; readonly problem: RecipientProblem }
  | { readonly kind: "no_addressee" }
  | { readonly kind: "over_provider_limit"; readonly sequence: number; readonly totalBytes: number };

export type PackagePlanResult =
  | { readonly ok: true; readonly plan: SubmissionPackagePlan }
  | { readonly ok: false; readonly problem: PackagePlanProblem };

export interface PackagePlanInput {
  readonly context: SubmissionContext;
  readonly recipients: readonly RecipientDraft[];
  readonly documents: readonly CandidateDocument[];
  readonly sender: EmailSender;
  readonly limitBytes?: number | undefined;
  /** The provider's own whole-message limit. Defaults to Gmail's. */
  readonly providerMaxMessageBytes?: number | undefined;
}

/**
 * Plain-language refusals, kept here beside the rules for the reason
 * `recipients.ts` keeps its own: the same problem must read identically in the
 * selection step, the review step and a toast.
 */
export function describePackageProblem(problem: PackagePlanProblem): string {
  switch (problem.kind) {
    case "recipients":
      return describeProblem(problem.problem);
    case "no_addressee":
      return "Everybody is copied and nobody is addressed. Mark at least one banker as 'To'.";
    case "nothing_selected":
      return "Choose at least one verified document to send.";
    case "document_not_sendable":
      // One wording per reason across the whole system — the selection list
      // shows the same sentence beside the row it disabled.
      return `${problem.document.label} cannot be sent. ${describeIneligibility(problem.reason)}`;
    case "over_provider_limit":
      // Unreachable while the AOS ceiling stays an order of magnitude under
      // Gmail's, which attachments.test.ts asserts. Kept because "unreachable"
      // is a property of today's constants, not of the code, and a silent
      // provider rejection after the user pressed Send is the failure this
      // exists to prevent.
      return (
        `Email ${problem.sequence} would be too large for the mail provider once encoded. ` +
        "Deselect a document and send it separately."
      );
  }
}

/**
 * Build the package, or say exactly why it cannot be built.
 *
 * The order of checks is the order a user can act on them: who it is going to,
 * then what is going, then how it is split. A size complaint about a
 * submission that has no addressee is not the most useful thing to say first.
 */
export function planSubmissionPackage(input: PackagePlanInput): PackagePlanResult {
  const validated = validateRecipients(input.recipients);
  if (!validated.ok) {
    return { ok: false, problem: { kind: "recipients", problem: validated.problem } };
  }

  const to = validated.recipients.filter((recipient) => recipient.kind === "to");
  const cc = validated.recipients.filter((recipient) => recipient.kind === "cc");
  if (to.length === 0) {
    return { ok: false, problem: { kind: "no_addressee" } };
  }

  const limitBytes = input.limitBytes ?? MAX_ATTACHMENT_BYTES_PER_EMAIL;
  const batched = planBatches(input.documents, { limitBytes });
  if (!batched.ok) {
    return { ok: false, problem: batched.problem };
  }

  // The greeting names the primary addressee — the person the file is for, not
  // whoever happens to sort first. `to` is non-empty by the check above.
  const greeted = to.find((recipient) => recipient.isPrimary) ?? (to[0] as (typeof to)[number]);
  const greetedRecipient: BankerRecipient = toBanker(greeted);

  const batchCount = batched.batches.length;
  const emails: PlannedEmail[] = [];

  for (const batch of batched.batches) {
    if (!fitsProviderMessageLimit(batch.totalBytes, input.providerMaxMessageBytes)) {
      return {
        ok: false,
        problem: {
          kind: "over_provider_limit",
          sequence: batch.sequence,
          totalBytes: batch.totalBytes,
        },
      };
    }

    emails.push({
      sequence: batch.sequence,
      subject: composeSubject(input.context, batch, batchCount),
      body: composeBody({
        context: input.context,
        recipient: greetedRecipient,
        batch,
        batchCount,
        sender: input.sender,
      }),
      documents: batch.documents,
      totalBytes: batch.totalBytes,
      groups: batch.groups,
    });
  }

  return {
    ok: true,
    plan: {
      emails,
      to: to.map(toBanker),
      cc: cc.map(toBanker),
      documentCount: input.documents.length,
      totalBytes: input.documents.reduce((total, document) => total + document.fileSizeBytes, 0),
      sender: input.sender,
      context: input.context,
    },
  };
}

function toBanker(recipient: { email: string; name?: string | undefined }): BankerRecipient {
  return {
    email: recipient.email,
    ...(recipient.name !== undefined ? { name: recipient.name } : {}),
  };
}

/**
 * Every document in the plan appears exactly once.
 *
 * An invariant rather than a check the caller is asked to remember: it is
 * asserted by `package.test.ts` over generated inputs, and exported so the
 * store can assert it once more immediately before sending. Two assertions of
 * the same invariant is cheap; a document silently omitted from a bank
 * submission is not.
 */
export function documentIdsIn(plan: SubmissionPackagePlan): readonly string[] {
  return plan.emails.flatMap((email) => email.documents.map((document) => document.documentId));
}
