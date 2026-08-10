/**
 * The shapes the API returns.
 *
 * Hand-written rather than generated: there is one server and one client in
 * one repository, and a codegen step would be more machinery than the problem
 * deserves. They mirror the `*FromRow` functions in `Backend/customers.ts`,
 * `Backend/cases.ts` and `Backend/reference.ts` — if one of those gains a
 * field, this is the file that has to agree.
 *
 * Deliberately NOT reusing `Frontend/src/fake/types.ts`. The prototype's
 * `Person` and `LoanCase` carry fields the database does not have (`tags`) and
 * omit fields it does (`lostAt`, `holdUntil`), and sharing one type would mean
 * every screen guessing which half is real. Two honest types, and the
 * migration is visible in the imports.
 */

import type { CaseStage, LostReason } from "@domain/case/stages.js";
import type { EffectivePermissionStatus, Role, Scope } from "@domain/permissions/index.js";

export type IdentifierType = "phone" | "pan" | "email" | "bank_account";

export interface ApiIdentifier {
  readonly id: string;
  readonly type: IdentifierType;
  readonly value: string;
  readonly isPrimary: boolean;
  readonly verificationSource: "self_declared" | "seen_on_document" | "verified_against_issuer";
}

export interface ApiCustomer {
  readonly id: string;
  readonly fullName: string;
  readonly dateOfBirth: string | null;
  readonly addressLine: string | null;
  readonly locality: string | null;
  readonly city: string | null;
  readonly district: string | null;
  readonly state: string | null;
  readonly pincode: string | null;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly identifiers: readonly ApiIdentifier[];
  readonly aliases: readonly string[];
}

export interface ApiCase {
  readonly id: string;
  readonly caseNumber: string;
  readonly loanProductId: string;
  readonly requestedAmount: number | null;
  readonly stage: CaseStage;
  readonly ownerUserId: string;
  readonly createdByUserId: string | null;
  readonly source: string | null;
  readonly referralSourceId: string | null;
  readonly isOnHold: boolean;
  readonly holdReason: string | null;
  readonly holdUntil: string | null;
  readonly lostReason: LostReason | null;
  readonly lostNote: string | null;
  readonly lostAt: string | null;
  readonly stageBeforeLost: CaseStage | null;
  readonly isInvoiceRaised: boolean;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly applicantId: string | null;
  readonly applicantName: string | null;
  readonly applicantPhone: string | null;
  /**
   * Present on `/api/cases` (the All Cases list) only, from Stage 3C —
   * `Backend/requirements.ts`'s `caseListProgress`, computed from real
   * `document_requirement` rows. Absent on a single case fetched by id: the
   * case-detail screen reads the fuller `ApiCaseRequirements` from
   * `/api/cases/:id/requirements` instead, which also carries per-requirement
   * detail this summary does not.
   */
  readonly progress?: { readonly percentComplete: number; readonly applicableCount: number };
}

export type RequirementStatus = "pending" | "received" | "verified" | "rejected" | "waived" | "not_applicable";

export interface ApiRequirementDocument {
  readonly id: string;
  readonly fileName: string | null;
  readonly fileSizeBytes: number | null;
  readonly version: number;
  readonly uploadedAt: string;
  readonly uploadedByUserId: string | null;
  readonly verifiedAt: string | null;
  readonly verifiedByUserId: string | null;
}

export interface ApiRequirement {
  readonly id: string;
  /** `document_type.code` — resolve the customer-facing name, description and
   * category through `DOCUMENT_CATALOGUE` (`@domain/requirements`), which is
   * the one place those words live (Docs/Document Requirement Engine.md). */
  readonly documentTypeCode: string;
  readonly applicableFromStage: string;
  readonly applicability: "mandatory" | "optional" | "not_applicable";
  readonly status: RequirementStatus;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly requiredOfCasePartyId: string | null;
  readonly generatedByRuleCode: string | null;
  /** A rejection's reason, in the login desk's own words. */
  readonly reason: string | null;
  readonly document: ApiRequirementDocument | null;
}

/** From `@domain/requirements`'s `summariseProgress` — computed server-side
 * from real `document_requirement` rows, never recomputed in the browser. */
export interface ApiProgressSummary {
  readonly applicableCount: number;
  readonly verifiedCount: number;
  readonly receivedCount: number;
  readonly rejectedCount: number;
  readonly outstandingCount: number;
  readonly waivedCount: number;
  readonly notApplicableCount: number;
  readonly optionalCount: number;
  readonly upcomingCount: number;
  readonly percentComplete: number;
  readonly isReadyForSubmission: boolean;
}

export interface ApiCaseRequirements {
  readonly caseStage: CaseStage;
  readonly requirements: readonly ApiRequirement[];
  readonly progress: ApiProgressSummary;
}

/** A case as returned by `/api/customers/:id/cases` — the same shape plus the
 * role that person plays on it. */
export interface ApiCaseForPerson extends ApiCase {
  readonly partyRole: "applicant" | "co_applicant" | "guarantor" | "referrer" | "borrower_firm";
}

export interface ApiLoanProduct {
  readonly id: string;
  readonly name: string | null;
  readonly category: string;
  readonly variant: string;
  readonly code: string;
  readonly isActive: boolean;
  readonly displayOrder: number;
  readonly customerProductName: string | null;
  /** "Home Loan · Home Loan — Purchase", built server-side so every screen
   * shows the same label and none of them owns the fallback rule. */
  readonly label: string;
}

export interface ApiReferralSource {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly displayOrder: number;
}

export interface ApiReference {
  readonly loanProducts: readonly ApiLoanProduct[];
  readonly referralSources: readonly ApiReferralSource[];
}

export interface ApiUser {
  readonly id: string;
  readonly username: string;
  readonly fullName: string;
  readonly isActive: boolean;
  readonly roles: readonly Role[];
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
}

/** One live permission override on a user, from `/api/users/:id/permissions`.
 * `grantedByName` is a colleague's name, not a customer's — it is who made the
 * decision, which is the whole point of showing it. */
export interface ApiPermissionOverride {
  readonly id: string;
  readonly permission: string;
  readonly scope: Scope;
  readonly decision: "grant" | "deny";
  readonly grantedBy: string | null;
  readonly grantedByName: string | null;
  readonly grantedAt: string;
}

/**
 * One user's overrides and the resulting effective access, from
 * `/api/users/:id/permissions`.
 *
 * `effective` is computed SERVER-SIDE and sent whole rather than recomputed in
 * the browser from roles + overrides. The screen's job is to show what the
 * server believes, and a second computation of it here is exactly the drift
 * ADR-022 forbids — it would let the screen show an access level the server
 * does not agree with, which is worse than showing nothing.
 */
export interface ApiUserPermissions {
  readonly user: ApiUser;
  readonly overrides: readonly ApiPermissionOverride[];
  readonly effective: readonly ({ readonly permission: string } & EffectivePermissionStatus)[];
}

/** The signed-in employee, from `/api/auth/me`. Carries their own live
 * overrides so the UI's `can()` agrees with the server's. */
export interface ApiSessionUser {
  readonly id: string;
  readonly username: string;
  readonly fullName: string;
  readonly roles: readonly Role[];
  readonly overrides: readonly {
    readonly permission: string;
    readonly scope: Scope;
    readonly decision: "grant" | "deny";
  }[];
}

export interface ApiSearchHit {
  readonly kind: "person" | "case";
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly matchedOn: string;
}

// ---------------------------------------------------------------------------
// Banks & submissions (Stage 3D) — mirrors Backend/lenders.ts, Backend/submissions.ts
// ---------------------------------------------------------------------------

export interface ApiLenderContact {
  readonly id: string;
  readonly name: string | null;
  readonly designation: string | null;
  readonly workEmail: string | null;
  readonly workMobile: string | null;
  readonly isPrimary: boolean;
}

export interface ApiLenderBranch {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly addressLine: string | null;
  readonly operationalStatus: string;
  readonly contacts: readonly ApiLenderContact[];
}

export interface ApiLender {
  readonly id: string;
  readonly name: string;
  readonly lenderType: string | null;
  readonly branches: readonly ApiLenderBranch[];
}

export type SubmissionStatus =
  | "not_submitted"
  | "submitted"
  | "under_process"
  | "query_raised"
  | "eligibility_received"
  | "sanctioned"
  | "rejected"
  | "withdrawn"
  | "disbursed";

export interface ApiSubmissionRecipient {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
  readonly designation: string | null;
  readonly kind: "to" | "cc";
  readonly isPrimary: boolean;
}

export interface ApiSubmissionPackageSummary {
  readonly id: string;
  readonly status: "pending" | "sent" | "partially_sent" | "failed";
  readonly documentCount: number;
  readonly emailCount: number;
  readonly initiatedAt: string;
}

export interface ApiSubmission {
  readonly id: string;
  readonly caseId: string;
  readonly branchOrganisationId: string;
  readonly counterparty: string;
  readonly status: SubmissionStatus;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly recipients: readonly ApiSubmissionRecipient[];
  readonly latestPackage: ApiSubmissionPackageSummary | null;
}

export interface ApiSendableDocument {
  readonly requirementId: string;
  readonly documentId: string;
  readonly label: string;
  readonly documentTypeCode: string;
  readonly category: string;
  readonly fileName: string;
  readonly fileSizeBytes: number;
  readonly financialYearLabel?: string;
  readonly version: number;
  /** Present, with the reason, when this document may not be sent (e.g. too
   * large for one email). Absent means it may be selected. */
  readonly blockedBecause?: string;
}

export interface ApiPlannedEmail {
  readonly sequence: number;
  readonly subject: string;
  readonly body: string;
  readonly documents: readonly { readonly documentId: string; readonly label: string; readonly fileSizeBytes: number }[];
  readonly totalBytes: number;
}

export interface ApiPackagePlan {
  readonly emails: readonly ApiPlannedEmail[];
  readonly to: readonly { readonly email: string; readonly name?: string }[];
  readonly cc: readonly { readonly email: string; readonly name?: string }[];
  readonly documentCount: number;
  readonly totalBytes: number;
  readonly sender: { readonly name: string; readonly address: string };
}

export interface ApiPreparedPackage {
  readonly plan: ApiPackagePlan;
  readonly fingerprint: string;
}

export interface ApiSendResult {
  readonly submissionPackageId: string;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly message: string;
}

export interface ApiPackageEmail {
  readonly id: string;
  readonly sequence: number;
  readonly subject: string;
  readonly status: "pending" | "sent" | "failed";
  readonly attachmentCount: number;
  readonly attemptCount: number;
  readonly sentAt: string | null;
  readonly providerMessageId: string | null;
  readonly failureMessage: string | null;
}

export interface ApiPackage {
  readonly id: string;
  readonly status: "pending" | "sent" | "partially_sent" | "failed";
  readonly documentCount: number;
  readonly emailCount: number;
  readonly initiatedAt: string;
  readonly completedAt: string | null;
  readonly emails: readonly ApiPackageEmail[];
}
