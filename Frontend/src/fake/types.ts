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
}

export interface Employment {
  id: Id;
  personId: Id;
  organisationId: Id;
  designation?: string;
  monthlyIncome?: number;
  employmentType: "salaried" | "self_employed" | "business_owner";
  isCurrent: boolean;
}

export interface Property {
  id: Id;
  buildingName?: string;
  doorNumber?: string;
  locality?: string;
  city?: string;
  propertyType?: string;
  estimatedValue?: number;
}

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
}

export interface DocumentType {
  id: Id;
  code: string;
  name: string;
  ownerKind: "person" | "property" | "organisation" | "case";
  requiresPeriod: boolean;
}

export interface RejectionReason {
  id: Id;
  code: string;
  name: string;
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
  fileName: string;
  fileSizeBytes: number;
  uploadedAt: string;
  uploadedBy: Id;
  verifiedAt?: string;
  verifiedBy?: Id;
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
