/**
 * The prototype's data shapes.
 *
 * Deliberately the schema's shape, minus the parts a prototype cannot exercise:
 * no versions, no merges, no redaction, no masked views. Names match the tables
 * in Database/migrations so that replacing this store with the real backend is a
 * substitution rather than a translation.
 *
 * What is NOT faked here: business rules. Stages, transitions, progress and
 * permissions all come from src/domain/, which is the same code the server will
 * run. If the prototype lets you do something, it is because the domain layer
 * allowed it.
 */

import type { CaseStage, LostReason } from "@domain/case/stages.js";
import type { RequirementStatus } from "@domain/requirements/progress.js";
import type { ProgressionStage } from "@domain/case/stages.js";
import type { Role } from "@domain/permissions/index.js";

export type Id = string;

export interface Person {
  id: Id;
  fullName: string;
  dateOfBirth?: string;
  locality?: string;
  city?: string;
  aliases: string[];
  identifiers: PersonIdentifier[];
}

export interface PersonIdentifier {
  id: Id;
  type: "phone" | "pan" | "email" | "bank_account";
  value: string;
  isPrimary: boolean;
  verificationSource: "self_declared" | "seen_on_document" | "verified_against_issuer";
}

export interface Organisation {
  id: Id;
  canonicalName: string;
  roles: Array<"employer" | "borrower" | "builder" | "developer" | "vendor" | "lender" | "branch">;
  industry?: string;
  city?: string;
  parentOrganisationId?: Id;
  aliases: string[];
  /** Meaningful only for organisations holding the `borrower` role
   * (ADR-014). Master data — see MasterDataRecord below. */
  businessConstitutionId?: Id;
  /** Does this organisation still exist? Absent means yes, matching the
   * column's default (Database/migrations/0003). For a lender this is
   * deliberately NOT panel status: Lakshmi Vilas Bank is inactive because it
   * ceased to exist, while a lender Amaze has stopped using is merely off
   * panel — see LenderProfile.isOnPanel (Milestone 8). */
  isActive?: boolean;
}

export interface Employment {
  id: Id;
  personId: Id;
  organisationId: Id;
  designation?: string;
  monthlyIncome?: number;
  employmentType: "salaried" | "self_employed" | "business_owner";
  /** The master-data replacement for `employmentType` (Milestone 5,
   * Database/migrations/0012). Both are kept: `employmentType` is what the
   * requirement-generation domain logic branches on, `employmentTypeId` is
   * what the admin screen and future new values point at. */
  employmentTypeId?: Id;
  isCurrent: boolean;
}

export interface Property {
  id: Id;
  buildingName?: string;
  doorNumber?: string;
  locality?: string;
  city?: string;
  propertyType?: string;
  propertyTypeId?: Id;
  ownershipStatus?: string;
  propertyOwnershipTypeId?: Id;
  estimatedValue?: number;
}

/**
 * Shared shape for the Master Data Engine's controlled-vocabulary tables
 * (Milestone 5, Database/migrations/0012): loan categories, employment
 * types, business constitutions, property types, property ownership types,
 * referral sources, districts and cities. One shape, learned once — the same
 * reasoning as the DB migration's header comment.
 *
 * `districtId` is meaningful only on `Database.cities`; `state` only on
 * `Database.districts`. Every other collection ignores whichever does not
 * apply to it — the same "one shared shape, most fields unused most of the
 * time" trade-off `rejectionReasons` already made for `displayOrder`.
 */
export interface MasterDataRecord {
  id: Id;
  code: string;
  name: string;
  description?: string;
  isActive: boolean;
  displayOrder: number;
  effectiveFrom?: string;
  notes?: string;
  districtId?: Id;
  state?: string;
}

/** Was `LoanCategory` (Milestone 5). Renamed in Milestone 7.1 (ADR-033) —
 * this record already modelled what office staff call a "Customer Product"
 * (Home Loan, Business Loan, LAP), grouping several lending products
 * underneath it. */
export type CustomerProduct = MasterDataRecord;
export type EmploymentTypeRecord = MasterDataRecord;
export type BusinessConstitution = MasterDataRecord;
export type PropertyTypeRecord = MasterDataRecord;
export type PropertyOwnershipTypeRecord = MasterDataRecord;
export type ReferralSource = MasterDataRecord;
export type District = MasterDataRecord;
export type City = MasterDataRecord;
// Lending Product Catalogue (Milestone 7) — Database/migrations/0015. Same
// shared shape again, which is the point: three more vocabularies and no new
// concept for office staff to learn.
export type BorrowerType = MasterDataRecord;
export type SecurityType = MasterDataRecord;
export type RequirementApplicability = MasterDataRecord;
// Bank & NBFC Catalogue (Milestone 8) — Database/migrations/0019. The shared
// shape a fourth time. `lenderTypes` supersedes the three-value
// `app.lender_type` enum (ADR-034) without a new concept for staff to learn.
export type LenderTypeRecord = MasterDataRecord;
export type LenderRelationshipRole = MasterDataRecord;
export type SubmissionMode = MasterDataRecord;
export type LenderInsightCategory = MasterDataRecord;

export interface AppUser {
  id: Id;
  personId: Id;
  name: string;
  roles: Role[];
  isActive: boolean;
}

/**
 * A lending product — Amaze's own, bank-independent (ADR-016, ADR-032, ADR-033).
 *
 * The middle layer of the catalogue: `customerProductId` groups it commercially,
 * `bank_product` (not yet in the prototype) is a lender's version of it.
 * Mirrors `loan_product` after Database/migrations/0015, 0017.
 *
 * The three eligibility arrays are this prototype's projection of the
 * junction tables `loan_product_borrower_type`,
 * `loan_product_employment_type` and `loan_product_business_constitution`.
 * An EMPTY array means the product admits nobody on that axis (a salaried
 * personal loan has no business constitutions) — that emptiness is an
 * answer, not a missing row.
 */
/** Active, Temporarily Suspended or Retired (Database/migrations/0017). */
export type AvailabilityStatus = "active" | "temporarily_suspended" | "retired";

export interface LoanProduct {
  id: Id;
  code: string;
  /** Legacy free text, still populated so nothing reading it breaks. `name`
   * and `customerProductId` are what new code reads (Database/migrations/0015). */
  category: string;
  variant: string;
  /** Was `loanCategoryId` (Milestone 5). Renamed in Milestone 7.1 (ADR-033). */
  customerProductId?: Id;
  name?: string;
  description?: string;
  securityTypeId?: Id;
  propertyRequirementId?: Id;
  gstRequirementId?: Id;
  borrowerTypeIds?: Id[];
  employmentTypeIds?: Id[];
  businessConstitutionIds?: Id[];
  /** Typical market ranges, never a rule — the binding figures are per
   * lender, on bank_product (ADR-016). */
  minTenureMonths?: number;
  maxTenureMonths?: number;
  minAmount?: number;
  maxAmount?: number;
  isActive: boolean;
  /**
   * Richer than `isActive` alone (Milestone 7.1, ADR-033). Undefined is
   * treated as `"active"` when `isActive` is true and `"retired"` otherwise,
   * so existing data and code that only knows `isActive` still behaves.
   */
  availabilityStatus?: AvailabilityStatus;
  displayOrder: number;
  effectiveFrom?: string;
  effectiveTo?: string;
  /** Set when this product is a revision of an earlier one. Nothing creates
   * a revision yet; the field exists so the first one is data entry. */
  supersedesLoanProductId?: Id;
  /** Who typically takes this product — "Salaried Employee", "Textile Unit",
   * "NRI". Informational only, NOT an eligibility rule (Milestone 7.1). */
  typicalCustomerProfile?: string;
  /** A short, human-readable summary of what is usually asked for — guidance,
   * not a requirement template (Milestone 7.1). */
  typicalDocumentsSummary?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Bank & NBFC Catalogue (Milestone 8) — Database/migrations/0019, 0020.
//
// The five concepts the milestone keeps apart, in the same five shapes the
// schema uses. Four of them extend what already existed rather than replacing
// it: an institution is an `Organisation` holding the `lender` role plus a
// `LenderProfile`, and a branch is an `Organisation` holding the `branch`
// role plus a `BankBranch` (ADR-014, ADR-015). There is deliberately no
// second "bank" entity beside `Organisation`.
// ---------------------------------------------------------------------------

/** Extension on an `Organisation` holding the `lender` role. Mirrors
 * `lender_profile` after Database/migrations/0019. */
export interface LenderProfile {
  organisationId: Id;
  /** Master data (`lenderTypes`). Supersedes the free-text `lenderType`
   * below, which is kept and kept populated (ADR-034). */
  lenderTypeId?: Id;
  /** The legacy three-value enum: bank / nbfc / hfc. Widened, never wrong —
   * a Small Finance Bank is recorded here as a bank. */
  lenderType: "bank" | "nbfc" | "hfc";
  /** Stable internal handle: sbi, hdfc_bank, bajaj_finance. */
  code?: string;
  headOfficeCity?: string;
  /** Free text, as staff say it: "Tamil Nadu and Kerala", "Pan-India". */
  primaryServiceRegion?: string;
  websiteUrl?: string;
  /** Does Amaze currently work with this lender? Distinct from the
   * organisation's own active flag, which is whether it still exists. */
  isOnPanel: boolean;
  /** Calendar days, as the office observes it. Informational, never an SLA. */
  typicalTurnaroundDays?: number;
  // Business intelligence. All prose, all written by staff for staff —
  // nothing here is an eligibility rule (ADR-016, ADR-034).
  preferredCustomerSegments?: string;
  knownStrengths?: string;
  knownLimitations?: string;
  commonRejectionPatterns?: string;
  internalRemarks?: string;
  notes?: string;
  displayOrder: number;
}

/** operational / temporarily_closed / closed. Distinct from the
 * organisation's active flag (Database/migrations/0019). */
export type BranchStatus = "operational" | "temporarily_closed" | "closed";

/** Extension on an `Organisation` holding the `branch` role. */
export interface BankBranch {
  organisationId: Id;
  branchCode?: string;
  cityId?: Id;
  districtId?: Id;
  addressLine?: string;
  contactNumber?: string;
  email?: string;
  operationalStatus: BranchStatus;
  notes?: string;
  displayOrder: number;
}

/**
 * A person's working relationship with a lender — the relationship manager.
 * Mirrors `bank_contact` after Database/migrations/0019.
 *
 * The institution is required and the branch optional: a regional manager
 * belongs to no single branch, and that is a complete record rather than a
 * partial one. Work mobile and work email are here and not on
 * `PersonIdentifier` because they belong to the posting, not to the person
 * (ADR-013).
 */
export interface BankContact {
  id: Id;
  personId: Id;
  institutionOrganisationId: Id;
  branchOrganisationId?: Id;
  /** Master data (`lenderRelationshipRoles`). */
  relationshipRoleId?: Id;
  /** The lender's own job title, verbatim (ADR-028's two-layer pattern). */
  designation?: string;
  workMobile?: string;
  workEmail?: string;
  notes?: string;
  isActive: boolean;
}

/**
 * That a lender offers a lending product. NOT a redefinition of the product
 * — the definition stays in the Lending Product Catalogue and this only
 * names it. `organisationId` is the institution, or one of its branches when
 * that branch genuinely differs.
 */
export interface BankProduct {
  id: Id;
  organisationId: Id;
  loanProductId: Id;
  /** The lender's own name for it, or the lending product's name where the
   * office does not know one (Database/migrations/0019). */
  name: string;
  minAmount?: number;
  maxAmount?: number;
  indicativeRate?: number;
  notes?: string;
  isActive: boolean;
  displayOrder: number;
}

/**
 * How a file is lodged with a lender. REFERENCE MATERIAL — read by a person,
 * executed by nothing. The submission workflow is a later milestone and
 * works off `Submission` (Database/migrations/0006).
 */
export interface LenderSubmissionRule {
  id: Id;
  organisationId: Id;
  /** Absent means the rule covers every product this lender does. */
  loanProductId?: Id;
  submissionModeId?: Id;
  portalUrl?: string;
  whatToCarry?: string;
  loginFeeNotes?: string;
  turnaroundNotes?: string;
  notes?: string;
  isActive: boolean;
  displayOrder: number;
}

/**
 * The lender profile: a piece of institutional knowledge about working with
 * a lender, filed under a category and dated.
 *
 * GUIDANCE, NEVER A RULE. `body` is never parsed or branched on. It exists so
 * that what an experienced loan team knows stops living in two people's heads
 * — and so that a future assistant can quote it as something the team
 * observed rather than as a condition it checked (ADR-034).
 */
export interface LenderInsight {
  id: Id;
  /** An institution, or one of its branches. */
  organisationId: Id;
  lenderInsightCategoryId: Id;
  loanProductId?: Id;
  body: string;
  /** ISO date. Experience ages, and a reader who sees the date can discount it. */
  observedOn?: string;
  isActive: boolean;
  displayOrder: number;
}

export interface DocumentType {
  id: Id;
  code: string;
  name: string;
  description?: string;
  ownerKind: "person" | "property" | "organisation" | "case";
  requiresPeriod: boolean;
  requiresExpiry?: boolean;
  isActive: boolean;
  displayOrder: number;
}

export interface RejectionReason {
  id: Id;
  code: string;
  name: string;
  description?: string;
  isActive: boolean;
  displayOrder: number;
}

export type CasePartyRole =
  | "applicant"
  | "co_applicant"
  | "guarantor"
  | "referrer"
  | "borrower_firm";

export interface CaseParty {
  id: Id;
  caseId: Id;
  personId?: Id;
  organisationId?: Id;
  role: CasePartyRole;
  isPrimary: boolean;
  removedAt?: string;
}

export interface CaseProperty {
  id: Id;
  caseId: Id;
  propertyId: Id;
  role: "collateral" | "purchase" | "both";
}

export interface LoanCase {
  id: Id;
  caseNumber: string;
  loanProductId: Id;
  requestedAmount?: number;
  stage: CaseStage;
  ownerUserId: Id;
  source?: string;
  /** Master-data replacement for `source` (Milestone 5). `source` is kept
   * for backward compatibility and for cases created before this milestone. */
  referralSourceId?: Id;
  lostReason?: LostReason;
  lostNote?: string;
  stageBeforeLost?: CaseStage;
  isOnHold: boolean;
  holdReason?: string;
  holdUntil?: string;
  isInvoiceRaised: boolean;
  tags: string[];
  createdAt: string;
  closedAt?: string;
}

export interface DocumentFile {
  id: Id;
  documentTypeId: Id;
  ownerKind: "person" | "property" | "organisation" | "case";
  personId?: Id;
  propertyId?: Id;
  organisationId?: Id;
  caseId?: Id;
  /** Where the bytes live in object storage, computed by
   * @domain/storage's buildStoragePath — never chosen by a user.
   * Mirrors document.file_path (Database/migrations/0005). */
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  /** Which period this document covers, e.g. one financial year's ITR — set
   * to the same range as the requirement it satisfied. Mirrors
   * document.period_start/period_end (Database/migrations/0005). */
  periodStart?: string;
  periodEnd?: string;
  uploadedAt: string;
  uploadedBy: Id;
  verifiedAt?: string;
  verifiedBy?: Id;
  /** Documents are never overwritten (BR-031). 1 for a first upload;
   * incremented by @domain/storage's nextVersion for a replacement. */
  version: number;
  /** The document this one replaces, if any — the audit trail
   * @domain/storage's versionHistory walks. Mirrors
   * document.supersedes_document_id (Database/migrations/0005). */
  supersedesDocumentId?: Id;
}

export interface DocumentRequirement {
  id: Id;
  caseId: Id;
  documentTypeId: Id;
  requiredOfCasePartyId?: Id;
  requiredOfCasePropertyId?: Id;
  status: RequirementStatus;
  applicableFromStage: ProgressionStage;
  satisfiedByDocumentId?: Id;
  waivedBy?: Id;
  waivedAt?: string;
  reason?: string;
  /** The financial year (or other period) this specific row is for, when the
   * document type needs more than one period — e.g. separate rows for ITR
   * FY2024-25 and FY2023-24. Mirrors document.period_start/period_end
   * (Database/migrations/0011). Undefined for document types that are not
   * financial-year-scoped. */
  periodStart?: string;
  periodEnd?: string;
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

export interface Submission {
  id: Id;
  caseId: Id;
  branchOrganisationId: Id;
  status: SubmissionStatus;
  submittedAt?: string;
  rejectionReasonId?: Id;
  bankReasonText?: string;
  loginFeeAmount?: number;
  bankReferenceNumber?: string;
  createdAt: string;
}

export interface Offer {
  id: Id;
  submissionId: Id;
  sanctionedAmount: number;
  interestRate?: number;
  tenureMonths?: number;
  processingFee?: number;
  validUntil?: string;
  isAccepted: boolean;
}

export interface Communication {
  id: Id;
  caseId?: Id;
  personId: Id;
  channel: "call" | "whatsapp" | "email" | "sms" | "meeting";
  direction: "inbound" | "outbound";
  occurredAt: string;
  subject?: string;
  body?: string;
  recordedBy: Id;
}

export interface Note {
  id: Id;
  caseId: Id;
  authorId: Id;
  body: string;
  createdAt: string;
}

export interface Task {
  id: Id;
  caseId?: Id;
  assignedTo: Id;
  title: string;
  dueAt?: string;
  completedAt?: string;
}

export interface AosEvent {
  id: Id;
  occurredAt: string;
  actorKind: "user" | "system";
  actorUserId?: Id;
  caseId?: Id;
  entityType: string;
  entityId?: Id;
  eventType: string;
  summary: string;
  causedBy?: string;
}

export interface Database {
  people: Person[];
  organisations: Organisation[];
  employments: Employment[];
  properties: Property[];
  users: AppUser[];
  loanProducts: LoanProduct[];
  documentTypes: DocumentType[];
  rejectionReasons: RejectionReason[];
  // Master Data Engine (Milestone 5) — Database/migrations/0012. Renamed
  // from loanCategories in Milestone 7.1 (ADR-033).
  customerProducts: CustomerProduct[];
  employmentTypes: EmploymentTypeRecord[];
  businessConstitutions: BusinessConstitution[];
  propertyTypes: PropertyTypeRecord[];
  propertyOwnershipTypes: PropertyOwnershipTypeRecord[];
  referralSources: ReferralSource[];
  districts: District[];
  cities: City[];
  // Lending Product Catalogue (Milestone 7) — Database/migrations/0015.
  borrowerTypes: BorrowerType[];
  securityTypes: SecurityType[];
  requirementApplicabilities: RequirementApplicability[];
  // Bank & NBFC Catalogue (Milestone 8) — Database/migrations/0019, 0020.
  lenderTypes: LenderTypeRecord[];
  lenderRelationshipRoles: LenderRelationshipRole[];
  submissionModes: SubmissionMode[];
  lenderInsightCategories: LenderInsightCategory[];
  lenderProfiles: LenderProfile[];
  bankBranches: BankBranch[];
  bankContacts: BankContact[];
  bankProducts: BankProduct[];
  lenderSubmissionRules: LenderSubmissionRule[];
  lenderInsights: LenderInsight[];
  cases: LoanCase[];
  caseParties: CaseParty[];
  caseProperties: CaseProperty[];
  documents: DocumentFile[];
  requirements: DocumentRequirement[];
  submissions: Submission[];
  offers: Offer[];
  communications: Communication[];
  notes: Note[];
  tasks: Task[];
  events: AosEvent[];
  caseNumberSequence: Record<number, number>;
}
