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
import type { Role, Scope } from "@domain/permissions/index.js";

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
