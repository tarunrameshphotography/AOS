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
import type { DocumentCategory, PeriodKind } from "@domain/requirements/document-catalogue.js";
import type { RequirementStatus } from "@domain/requirements/progress.js";
import type { ConstructionStage, RequirementRule } from "@domain/requirements/rules.js";
import type { ApplicabilityCode } from "@domain/products/index.js";
import type { ProgressionStage } from "@domain/case/stages.js";
import type { Role, Scope } from "@domain/permissions/index.js";

export type Id = string;

export interface Person {
  id: Id;
  fullName: string;
  dateOfBirth?: string;
  /** Mirrors person.address_line (Database/migrations/0002) — carried by the
   * schema since the beginning, only now exposed and editable in the
   * frontend (Telecaller Real-World Issues milestone, Part 3). */
  addressLine?: string;
  locality?: string;
  city?: string;
  /** Mirrors person.pincode (Database/migrations/0002), same story as
   * addressLine. */
  pincode?: string;
  /** Free text, matching the precedent set by LoanCase.source before
   * referralSourceId existed: a plain answer now, a master-data link a
   * later, separate decision (Database/migrations/0028). */
  district?: string;
  state?: string;
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
  /** The business's own address (Database/migrations/0028), mirroring what
   * Person has carried since the beginning. */
  addressLine?: string;
  locality?: string;
  pincode?: string;
  district?: string;
  state?: string;
  parentOrganisationId?: Id;
  aliases: string[];
  /** Meaningful only for organisations holding the `borrower` role
   * (ADR-014). Master data — see MasterDataRecord below. */
  businessConstitutionId?: Id;
  /**
   * PROFILE facts about this business — Database/migrations/0028. Set once,
   * on the business's own record, and shown on the customer profile.
   *
   * DELIBERATELY NOT READ BY THE REQUIREMENT ENGINE. `LoanCase.isGstRegistered`
   * (below) is the fact `@domain/requirements` evaluates to decide what ONE
   * case is asked for; this is what the business itself reports, independent
   * of any case. The two are allowed to disagree — a business's own record
   * and what was recorded for one particular loan are different questions —
   * and nothing in `Frontend/src/fake/requirements.ts`'s `buildCaseFacts` may
   * read these four fields. If a future milestone wants them to inform the
   * engine, that is a deliberate design decision to make then, not a wire to
   * connect now.
   */
  isGstRegistered?: boolean;
  gstin?: string;
  udyamRegistered?: boolean;
  udyamNumber?: string;
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
  /** The employee ID they log in with. Compared case-insensitively. */
  username: string;
  /** PBKDF2-SHA256 (src/domain/auth/password.ts). Never plaintext, never rendered. */
  passwordHash: string;
  roles: Role[];
  isActive: boolean;
  /** Explicit grants/denials on top of role-derived access (Employee Authentication milestone). */
  permissionOverrides?: PermissionOverride[];
}

/**
 * A grant or deny of one permission for one user, on top of their roles.
 *
 * Revoked, never deleted — `revokedAt` set means the override no longer
 * applies, but the record of it having existed stays (same convention as
 * `user_role`'s `revoked_at`, Database/migrations/0002).
 */
export interface PermissionOverride {
  id: Id;
  permission: string;
  scope: Scope;
  decision: "grant" | "deny";
  grantedByUserId: Id;
  grantedAt: string;
  revokedByUserId?: Id;
  revokedAt?: string;
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
  /**
   * The human being, when there is one (Milestone 10,
   * Database/migrations/0024).
   *
   * Optional since the Bank Submission Workflow: a great many of the
   * addresses a file is actually sent to are desks, not people —
   * "homeloans.cbe@bank.com" is an address and inventing a `Person` to hold
   * it would put fictional people in an operational contact list. Kept rather
   * than replaced by `contactName`, because a named manager who moves to
   * another bank next year is one new contact against the same person, which
   * is the whole point of ADR-006 and ADR-014.
   */
  personId?: Id;
  /** The name as the office recorded it, and the display name. Optional —
   * a shared mailbox has none, and that is a complete record. */
  contactName?: string;
  institutionOrganisationId: Id;
  branchOrganisationId?: Id;
  /** Master data (`lenderRelationshipRoles`). */
  relationshipRoleId?: Id;
  /** The lender's own job title, verbatim (ADR-028's two-layer pattern). */
  designation?: string;
  workMobile?: string;
  workEmail?: string;
  /** The one contact at this branch a file goes to first. At most one per
   * branch among the active contacts — a second is a data entry mistake, not
   * a preference. The Add Bank workflow pre-selects it. */
  isPrimaryContact?: boolean;
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
  /** What we call it to the customer (Telecaller Workflow milestone). */
  name: string;
  /**
   * What it is called locally when that differs — "Villangam Certificate" for
   * an EC, "Udyog Aadhaar" for Udyam, "GST 3B" for GSTR-3B. Shown beside the
   * official name, never instead of it: the customer says one and the bank
   * wants the other, and the telecaller needs both in front of them.
   */
  localName?: string;
  /** One sentence a first-week joiner can read out loud. */
  description?: string;
  /**
   * What actually counts, where the honest answer is a list rather than a
   * sentence — "what can I give for address proof?" is the most-asked
   * question on a collection call.
   */
  examples?: string[];
  /**
   * Which section of the collection call this appears in. A flat list of
   * forty rows is a list nobody reads.
   */
  category?: DocumentCategory;
  ownerKind: "person" | "property" | "organisation" | "case";
  requiresPeriod: boolean;
  /**
   * How a per-period row names its period to the customer: by financial year,
   * or by assessment year for the returns. The window is the same either way;
   * the customer's name for it is not (Document Requirement Engine audit).
   */
  periodKind?: PeriodKind;
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
  /**
   * Case-specific overrides the Document Requirement Engine reads
   * (Milestone 9, Database/migrations/0021). Undefined means "use the
   * person's employment record / the organisation's constitution", which is
   * the normal case and keeps each fact in exactly one place (Principle #5).
   *
   * They exist because a case screen must never rewrite a shared person
   * record to change one case's requirements — a person underwritten as
   * salaried on one file and as a business owner on another is two facts, not
   * one fact that keeps changing.
   */
  employmentTypeId?: Id;
  borrowerTypeId?: Id;
  businessConstitutionId?: Id;
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
  /**
   * Who first brought this case in — set once, at creation, and never
   * changed afterward (Database/migrations/0004's `created_by`, exposed here
   * for the first time in the real-world-issues milestone, Part 4).
   *
   * Deliberately distinct from `ownerUserId`, which is who is CURRENTLY
   * responsible and does change (`assignOwner`). "Which telecaller brought
   * this case in" and "who has it right now" are different questions, and
   * collapsing them into one field is what made the case header's old
   * "owner" label ambiguous. Undefined on cases created before this field
   * existed — the UI falls back to the case's earliest `case.created` event.
   */
  createdByUserId?: Id;
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
  /**
   * Case facts the Document Requirement Engine reads (Milestone 9,
   * Database/migrations/0021).
   *
   * All three are deliberately THREE-VALUED: undefined is "nobody has asked
   * yet", which is not the same as false. The rules use is_true / is_false
   * precisely so an unanswered question never silently generates — or
   * silently suppresses — a requirement.
   */
  isGstRegistered?: boolean;
  constructionStage?: ConstructionStage;
  hasExistingObligations?: boolean;
}

/**
 * A document requirement rule, as the prototype stores it (Milestone 9,
 * ADR-035). The domain shape plus an id — the engine itself never sees the
 * id, because a pure evaluator has no database to resolve one against.
 *
 * Seeded from DEFAULT_REQUIREMENT_RULES and editable afterwards, which is the
 * milestone's whole point: a business user changes what AOS asks for without
 * a developer and without a deploy.
 */
export interface DocumentRequirementRule extends RequirementRule {
  id: Id;
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
  /** The storage root (`StorageConfig.root`) configured on the storage
   * backend at the moment this document's bytes were written and verified
   * readable. Lets a later "File missing on disk" be told apart from "the
   * storage root was reconfigured since" — see @domain/storage's
   * classifyStorageState. Undefined for documents uploaded before this was
   * tracked. */
  storageRoot?: string;
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
  /** Free-text left by the Login Executive in the verify/confirm dialog —
   * e.g. "PAN readable" or "Uploaded Aadhaar is blurry". Becomes part of the
   * document's history alongside the document.verified event. */
  verificationNotes?: string;
  /** Set (with a reason) when a reviewer rejects the upload in the
   * verify/confirm dialog instead of confirming it. The document itself is
   * never deleted — the next upload against the same requirement supersedes
   * it, same as any other replacement (BR-031). */
  rejectedAt?: string;
  rejectedBy?: Id;
  rejectionReason?: string;
  /** What the document was expected/detected to be at upload time. Today
   * this always equals `documentTypeId` — there is no OCR yet — but keeping
   * it a separate field is what lets a future OCR suggestion and a human's
   * confirmed type disagree without a schema change. */
  suggestedDocumentTypeId?: Id;
  /** What a human actually confirmed the document to be, set when the
   * verify/confirm dialog's "Confirm & Verify" is used. Undefined until
   * verified. */
  confirmedDocumentTypeId?: Id;
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
  /** Which rule asked for this (Milestone 9). Undefined for a row a user
   * added by hand — an extra financial year — and for anything generated
   * before the engine existed. This is the "why am I being asked for this?"
   * answer, and a checklist nobody can interrogate is one people work
   * around. */
  generatedByRuleCode?: string;
  /** mandatory or optional, carried down from the rule. Optional rows are
   * collected and verified like any other but never counted against the
   * case. Undefined reads as mandatory. */
  applicability?: ApplicabilityCode;
  /**
   * A requirement a Login Executive added BY HAND, for this case only
   * (Telecaller Workflow milestone, Part 6).
   *
   * Rules cannot anticipate everything. A bank asks for one extra letter on
   * one file; a customer's situation has a wrinkle nobody wrote a rule for.
   * The alternative to supporting that is a user who keeps the extra document
   * in WhatsApp, which is how a document management system stops being one.
   *
   * It carries its own name, description and category rather than a document
   * type of its own, because a per-case document type is master data that
   * nobody owns — and because MASTER RULES ARE NEVER TOUCHED by adding one.
   * The row points at the `other_document` type purely so upload, versioning
   * and the storage path have something real to resolve.
   *
   * Regeneration preserves these rows untouched: they were not generated by a
   * rule, so no rule's absence can withdraw them.
   */
  isCustom?: boolean;
  customName?: string;
  customDescription?: string;
  customCategory?: DocumentCategory;
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
  /** The counterparty a file physically goes to (ADR-015). */
  branchOrganisationId: Id;
  /**
   * The lending institution (Milestone 10, Database/migrations/0024).
   * Reachable through the branch's parent link, but that is master data like
   * any other and a branch can be re-parented when banks merge — which is
   * exactly when you least want "which bank was this?" answered by walking a
   * mutable pointer.
   */
  institutionOrganisationId?: Id;
  /** How the file goes out — master data (`submissionModes`). Records intent
   * only. NOTHING IN AOS SENDS ANYTHING. */
  submissionModeId?: Id;
  /**
   * What the bank and branch were CALLED when the file went to them
   * (Milestone 10, ADR-036).
   *
   * Denormalised on purpose, and the one place in this prototype where that
   * is correct: master data is edited — branches are renamed, moved and
   * closed — and an edit must never rewrite what a historical submission says
   * it did. The live ids above are how you reach the branch as it is NOW;
   * these are what it was then, and neither can be derived from the other.
   */
  bankNameAtSubmission?: string;
  branchNameAtSubmission?: string;
  branchAddressAtSubmission?: string;
  branchCityAtSubmission?: string;
  /** When the snapshot was captured. Absent means the row was reconstructed
   * from master data rather than recorded at the time — a reconstruction is
   * not a record, and anything reporting on historical accuracy has to be
   * able to tell them apart. */
  snapshotTakenAt?: string;
  status: SubmissionStatus;
  submittedAt?: string;
  rejectionReasonId?: Id;
  bankReasonText?: string;
  loginFeeAmount?: number;
  bankReferenceNumber?: string;
  createdAt: string;
}

/**
 * One banker a submission was addressed to (Milestone 10, ADR-036,
 * Database/migrations/0024).
 *
 * Multiple recipients are the norm rather than an edge case: the relationship
 * manager, the credit manager who will actually raise the query, and the
 * branch's shared mailbox so the file does not die when one person is on
 * leave. A model holding one of them pushes the rest into a free-text note
 * where nothing can read them.
 *
 * Every field except the email is snapshotted from the catalogue at the
 * moment the bank was added, for the reason `Submission`'s own snapshot
 * exists — editing a contact must not rewrite who a historical file went to.
 */
export interface SubmissionRecipient {
  id: Id;
  submissionId: Id;
  /** The catalogue contact this came from, when it came from one. Absent for
   * an address typed in on the spot, which must stay possible or people keep
   * a second list outside the system. */
  bankContactId?: Id;
  email: string;
  contactName?: string;
  designation?: string;
  /** Who was addressed first on THIS file. Distinct from
   * `BankContact.isPrimaryContact`, which is the branch's standing
   * arrangement. */
  isPrimary: boolean;
  /** to / cc. Records the office's intent about who is addressed and who is
   * copied. Read by nothing today — it exists so a future Gmail or Outlook
   * integration consumes it rather than re-asking. */
  recipientKind: "to" | "cc";
  displayOrder: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Sending a case's documents to a banker (ADR-039) —
// Database/migrations/0030.
//
// Four shapes, and the reason each is separate is written on the migration.
// In short: the PACKAGE is the decision a person made, the EMAILS are what it
// took to carry it (and can fail independently), the RECIPIENTS are who
// actually received it, and the DOCUMENTS record which version went in which
// email, exactly once.
// ---------------------------------------------------------------------------

/** pending until the first send; `partially_sent` when some emails failed. */
export type SubmissionPackageStatus = "pending" | "sent" | "partially_sent" | "failed";

export interface SubmissionPackage {
  id: Id;
  submissionId: Id;
  /** Who pressed Send. Never the system (BR-032's principle). */
  initiatedBy: Id;
  initiatedAt: string;
  /** The mailbox it went from, snapshotted rather than read from config at
   * display time — configuration changes, history must not. */
  senderAddress: string;
  senderName: string;
  /** "gmail", "capture", "unconfigured" — whose sent mailbox to look in. */
  provider: string;
  status: SubmissionPackageStatus;
  documentCount: number;
  emailCount: number;
  totalBytes: number;
  completedAt?: string;
}

export interface SubmissionPackageRecipient {
  id: Id;
  submissionPackageId: Id;
  /** The submission recipient this was taken from, when it came from one.
   * Absent for an address typed on the spot. */
  submissionRecipientId?: Id;
  email: string;
  contactName?: string;
  recipientKind: "to" | "cc";
  displayOrder: number;
}

export type SubmissionPackageEmailStatus = "pending" | "sent" | "failed";

export interface SubmissionPackageEmail {
  id: Id;
  submissionPackageId: Id;
  /** 1-based, and the number the subject says: "(2/3)". */
  sequence: number;
  /** The subject only. The body is regenerated deterministically by
   * @domain/submissions' compose.ts, so storing it would copy customer data
   * into a second place for nothing (see the migration's column comment). */
  subject: string;
  status: SubmissionPackageEmailStatus;
  attachmentCount: number;
  attachmentBytes: number;
  attemptCount: number;
  sentAt?: string;
  providerMessageId?: string;
  /** The provider's category and its words, kept apart: the category is what
   * a retry decides on, the words are what a person reads. */
  failureKind?: string;
  failureMessage?: string;
}

export interface SubmissionPackageDocument {
  id: Id;
  submissionPackageId: Id;
  submissionPackageEmailId: Id;
  documentId: Id;
  /** Copied, not joined. A document replaced next month gets a new row
   * (BR-031); this is the version the banker actually holds. */
  documentVersion: number;
  fileName: string;
  fileSizeBytes: number;
  financialYearLabel?: string;
  displayOrder: number;
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
  // Document Requirement Engine (Milestone 9) — Database/migrations/0021, 0022.
  documentRequirementRules: DocumentRequirementRule[];
  submissions: Submission[];
  // Bank Submission Workflow (Milestone 10) — Database/migrations/0024.
  submissionRecipients: SubmissionRecipient[];
  // Document submission by email (ADR-039) — Database/migrations/0030.
  submissionPackages: SubmissionPackage[];
  submissionPackageRecipients: SubmissionPackageRecipient[];
  submissionPackageEmails: SubmissionPackageEmail[];
  submissionPackageDocuments: SubmissionPackageDocument[];
  offers: Offer[];
  communications: Communication[];
  notes: Note[];
  tasks: Task[];
  events: AosEvent[];
  caseNumberSequence: Record<number, number>;
}
