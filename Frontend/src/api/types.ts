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
  readonly requiredOfCasePropertyId: string | null;
  /** WHOSE document this is, resolved from the requirement's structural
   * subject rather than assembled from a string. What makes "Applicant — PAN
   * Card" and "Co-applicant — PAN Card" two visibly different rows. */
  readonly subject: {
    readonly kind: "party" | "property" | "case";
    readonly role: string | null;
    readonly name: string | null;
  };
  readonly generatedByRuleCode: string | null;
  /** Why this is being asked for, in the words of whoever wrote the rule.
   * Null on a hand-added row — no rule produced it. */
  readonly generatedByRuleName: string | null;
  readonly generatedByRuleNotes: string | null;
  /** An Additional Document: added by hand for this case, not asked for by a
   * rule (`document_requirement.is_custom`). */
  readonly isCustom: boolean;
  readonly customName: string | null;
  /** A rejection's reason, or — when `status` is `waived` — the waiver's
   * reason (BR-035). One column on `document_requirement` serves both, since
   * a requirement is never both at once. */
  readonly reason: string | null;
  /** Set together, never one without the other. Who excused this requirement
   * and when, so a waived row can say more than just "Waived" (Phase 4). */
  readonly waivedByUserId: string | null;
  readonly waivedAt: string | null;
  readonly document: ApiRequirementDocument | null;
}

// ---------------------------------------------------------------------------
// Case parties and properties (Phase 4 — case completeness) — mirrors
// Backend/case-composition.ts
// ---------------------------------------------------------------------------

export type CasePartyRole = "applicant" | "co_applicant" | "guarantor" | "referrer" | "borrower_firm";

export interface ApiCaseParty {
  readonly id: string;
  readonly caseId: string;
  readonly personId: string | null;
  readonly organisationId: string | null;
  readonly name: string | null;
  readonly role: CasePartyRole;
  readonly isPrimary: boolean;
  readonly employmentTypeId: string | null;
  readonly borrowerTypeId: string | null;
  readonly businessConstitutionId: string | null;
  /** Three-valued: null is "nobody has asked", which the rules read
   * differently from an explicit no (migration 0035). */
  readonly itrFiled: boolean | null;
  readonly isGstRegistered: boolean | null;
  readonly removedAt: string | null;
  readonly createdAt: string;
}

export type CasePropertyRole = "collateral" | "purchase" | "both";

export interface ApiCaseProperty {
  readonly id: string;
  readonly caseId: string;
  readonly propertyId: string;
  readonly role: CasePropertyRole;
  readonly removedAt: string | null;
  readonly createdAt: string;
  readonly doorNumber: string | null;
  readonly buildingName: string | null;
  readonly locality: string | null;
  readonly city: string | null;
  readonly pincode: string | null;
  readonly propertyTypeId: string | null;
  readonly propertyOwnershipTypeId: string | null;
  readonly areaSqft: number | null;
  readonly estimatedValue: number | null;
  readonly ownershipStatus: string | null;
  readonly surveyNumber: string | null;
  readonly registrationNumber: string | null;
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
  /** The commercial grouping's code — `home_loan`, `lap`, `business_loan`.
   * What the requirement engine calls `case.customer_product_code`. */
  readonly customerProductCode: string | null;
  /**
   * What the product itself declares about property and GST (ADR-032). The
   * New Case screen reveals its property and GST questions from these rather
   * than from a list of product codes written into the browser — a new
   * product added in Master Data then asks the right questions without a
   * frontend change.
   */
  readonly propertyRequirement: "mandatory" | "optional" | "not_applicable" | null;
  readonly gstRequirement: "mandatory" | "optional" | "not_applicable" | null;
  /** Which employment types, borrower types and constitutions this product is
   * offered to (`loan_product_employment_type` and friends, 0015). The intake
   * form offers exactly these and nothing else. */
  readonly employmentTypeIds: readonly string[];
  readonly borrowerTypeIds: readonly string[];
  readonly businessConstitutionIds: readonly string[];
  /** "Home Loan · Home Loan — Purchase", built server-side so every screen
   * shows the same label and none of them owns the fallback rule. */
  readonly label: string;
}

/** A master-data row as the reference endpoint returns it — employment types,
 * borrower types, constitutions, property types. Same five fields each. */
export interface ApiReferenceItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly displayOrder: number;
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
  /** The master data the New Case screen turns into dropdowns. On this one
   * endpoint rather than four for the reason its server-side comment gives:
   * every screen that needs one needs the others. */
  readonly employmentTypes: readonly ApiReferenceItem[];
  readonly borrowerTypes: readonly ApiReferenceItem[];
  readonly businessConstitutions: readonly ApiReferenceItem[];
  readonly propertyTypes: readonly ApiReferenceItem[];
}

// ---------------------------------------------------------------------------
// Master data (Stage 4 Item 4) — mirrors Backend/master-data.ts
// ---------------------------------------------------------------------------

export type DocumentCategory =
  | "kyc"
  | "business_registration"
  | "business_financials"
  | "income"
  | "property"
  | "additional";

export interface ApiDocumentType {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly localName?: string;
  readonly description?: string;
  readonly examples?: readonly string[];
  readonly category?: DocumentCategory;
  readonly ownerKind: "person" | "property" | "organisation" | "case";
  readonly requiresPeriod: boolean;
  readonly requiresExpiry: boolean;
  readonly periodKind?: "financial_year" | "assessment_year";
  readonly isActive: boolean;
  readonly displayOrder: number;
}

export interface ApiRejectionReason {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description?: string;
  readonly isActive: boolean;
  readonly displayOrder: number;
}

export interface ApiRuleCondition {
  readonly fact: string;
  readonly operator: string;
  readonly values?: readonly string[];
}

export interface ApiDocumentRequirementRule {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly documentTypeCode: string;
  readonly scope: "case" | "party" | "property";
  readonly partyRoles?: readonly string[];
  readonly partyKind?: "person" | "organisation";
  readonly propertyRoles?: readonly string[];
  readonly applicability: "mandatory" | "optional" | "not_applicable";
  readonly applicableFromStage: CaseStage;
  readonly financialYears?: number;
  readonly conditions: readonly ApiRuleCondition[];
  readonly match: "all" | "any";
  readonly isActive: boolean;
  readonly displayOrder: number;
  readonly notes?: string;
}

/** From `@domain/settings/thresholds.ts` — the key set is a closed enum
 * fixed in code; only `valueDays` is business-editable through the API. */
export interface ApiThreshold {
  readonly key: string;
  readonly valueDays: number;
  readonly description?: string;
  readonly updatedBy?: string;
  readonly updatedAt?: string;
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

export interface ApiOffer {
  readonly id: string;
  readonly submissionId: string;
  readonly sanctionedAmount: number;
  readonly interestRate: number | null;
  readonly tenureMonths: number | null;
  readonly processingFee: number | null;
  readonly conditions: string | null;
  readonly validUntil: string | null;
  readonly isAccepted: boolean;
  readonly acceptedAt: string | null;
  readonly createdAt: string;
}

export interface ApiSubmissionQuery {
  readonly id: string;
  readonly submissionId: string;
  readonly raisedAt: string;
  readonly question: string;
  readonly answeredAt: string | null;
  readonly answer: string | null;
}

export interface ApiSubmission {
  readonly id: string;
  readonly caseId: string;
  readonly branchOrganisationId: string;
  readonly counterparty: string;
  readonly status: SubmissionStatus;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly rejectionReasonId: string | null;
  readonly bankReasonText: string | null;
  readonly rejectedAt: string | null;
  readonly recipients: readonly ApiSubmissionRecipient[];
  readonly latestPackage: ApiSubmissionPackageSummary | null;
  readonly offers: readonly ApiOffer[];
  readonly queries: readonly ApiSubmissionQuery[];
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
  /** Added by hand for this case rather than asked for by a rule. Shown beside
   * the tick box; it changes no selection behaviour — the package is whatever
   * the operator ticked. */
  readonly isCustom: boolean;
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

// ---------------------------------------------------------------------------
// Case timeline — mirrors Backend/events.ts's listCaseEvents
// ---------------------------------------------------------------------------

export interface ApiTimelineEntry {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorKind: "user" | "system";
  /** Null when `actorKind` is `"system"` — a stage that moved itself because
   * every requirement was met, not an employee clicking a button. */
  readonly actorName: string | null;
  /** The raw type (`"case.stage_changed"`), kept for anything that ever needs
   * to key off it specifically. Screens should read `label`, not this. */
  readonly eventType: string;
  /** Clean, human text for `eventType` — what actually happened. */
  readonly label: string;
  /** A short second line where the event has one worth showing (the stage it
   * moved to, a lost reason) — never raw payload JSON. Null when there is
   * nothing more useful to say than `label` already does. */
  readonly detail: string | null;
}
