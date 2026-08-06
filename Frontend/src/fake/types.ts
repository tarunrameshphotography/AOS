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

export type LoanCategory = MasterDataRecord;
export type EmploymentTypeRecord = MasterDataRecord;
export type BusinessConstitution = MasterDataRecord;
export type PropertyTypeRecord = MasterDataRecord;
export type PropertyOwnershipTypeRecord = MasterDataRecord;
export type ReferralSource = MasterDataRecord;
export type District = MasterDataRecord;
export type City = MasterDataRecord;

export interface AppUser {
  id: Id;
  personId: Id;
  name: string;
  roles: Role[];
  isActive: boolean;
}

export interface LoanProduct {
  id: Id;
  code: string;
  category: string;
  variant: string;
  /** Master-data replacement for `category` (Milestone 5). `category` is
   * kept for backward compatibility until the Loan Product Catalogue
   * milestone rebuilds this table's own management screen. */
  loanCategoryId?: Id;
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
  // Master Data Engine (Milestone 5) — Database/migrations/0012.
  loanCategories: LoanCategory[];
  employmentTypes: EmploymentTypeRecord[];
  businessConstitutions: BusinessConstitution[];
  propertyTypes: PropertyTypeRecord[];
  propertyOwnershipTypes: PropertyOwnershipTypeRecord[];
  referralSources: ReferralSource[];
  districts: District[];
  cities: City[];
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
