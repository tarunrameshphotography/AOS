import { describe, expect, it } from "vitest";

import { financialYearGroups } from "./document-financial-years.js";
import type { Database, DocumentRequirement } from "../fake/types.js";

function baseDb(): Database {
  return {
    people: [{ id: "per_1", fullName: "Deepa Krishnan", aliases: [], identifiers: [] }],
    organisations: [],
    employments: [],
    properties: [],
    users: [],
    loanProducts: [],
    documentTypes: [
      { id: "dty_itr", code: "itr", name: "Income Tax Return", ownerKind: "person", requiresPeriod: true, isActive: true, displayOrder: 10 },
      { id: "dty_pan", code: "pan_card", name: "PAN Card", ownerKind: "person", requiresPeriod: false, isActive: true, displayOrder: 20 },
    ],
    rejectionReasons: [],
    customerProducts: [],
    employmentTypes: [],
    businessConstitutions: [],
    propertyTypes: [],
    propertyOwnershipTypes: [],
    referralSources: [],
    districts: [],
    cities: [],
    borrowerTypes: [],
    securityTypes: [],
    requirementApplicabilities: [],
    lenderTypes: [],
    lenderRelationshipRoles: [],
    submissionModes: [],
    lenderInsightCategories: [],
    lenderProfiles: [],
    bankBranches: [],
    bankContacts: [],
    bankProducts: [],
    lenderSubmissionRules: [],
    lenderInsights: [],
    cases: [],
    caseParties: [
      { id: "cpt_1", caseId: "cas_1", personId: "per_1", role: "applicant", isPrimary: true },
    ],
    caseProperties: [],
    documents: [],
    requirements: [],
    documentRequirementRules: [],
    submissions: [],
    submissionRecipients: [],
    submissionPackages: [],
    submissionPackageRecipients: [],
    submissionPackageEmails: [],
    submissionPackageDocuments: [],
    offers: [],
    communications: [],
    notes: [],
    tasks: [],
    events: [],
    caseNumberSequence: {},
  };
}

const REQUIREMENTS: DocumentRequirement[] = [
  {
    id: "req_fy25", caseId: "cas_1", documentTypeId: "dty_itr", requiredOfCasePartyId: "cpt_1",
    status: "pending", applicableFromStage: "documents_pending",
    periodStart: "2024-04-01", periodEnd: "2025-03-31",
  },
  {
    id: "req_fy24", caseId: "cas_1", documentTypeId: "dty_itr", requiredOfCasePartyId: "cpt_1",
    status: "verified", applicableFromStage: "documents_pending",
    periodStart: "2023-04-01", periodEnd: "2024-03-31",
  },
  {
    id: "req_fy23_na", caseId: "cas_1", documentTypeId: "dty_itr", requiredOfCasePartyId: "cpt_1",
    status: "not_applicable", applicableFromStage: "documents_pending",
    periodStart: "2022-04-01", periodEnd: "2023-03-31",
  },
  {
    id: "req_pan", caseId: "cas_1", documentTypeId: "dty_pan", requiredOfCasePartyId: "cpt_1",
    status: "pending", applicableFromStage: "documents_pending",
  },
];

describe("financialYearGroups", () => {
  it("groups financial-year-scoped rows by document type and subject, most recent year first", () => {
    const db = baseDb();
    const groups = financialYearGroups(db, REQUIREMENTS);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.documentTypeName).toBe("Income Tax Return");
    expect(groups[0]?.subjectLabel).toBe("Deepa Krishnan");
    // The badge carries its own FY/AY prefix since the engine audit — the
    // panel no longer prepends one, because an ITR row has to say AY.
    expect(groups[0]?.years.map((y) => y.label)).toEqual(["FY 2024-25", "FY 2023-24"]);
  });

  it("names an assessment-year document by its assessment year, one ahead of the financial year", () => {
    const db = baseDb();
    db.documentTypes = db.documentTypes.map((type) =>
      type.id === "dty_itr" ? { ...type, periodKind: "assessment_year" as const } : type,
    );

    const groups = financialYearGroups(db, REQUIREMENTS);

    // FY 2024-25 is assessed in AY 2025-26 — the number printed on the return
    // the customer actually holds.
    expect(groups[0]?.years.map((y) => y.label)).toEqual(["AY 2025-26", "AY 2024-25"]);
  });

  it("excludes not_applicable rows from the group", () => {
    const db = baseDb();
    const groups = financialYearGroups(db, REQUIREMENTS);
    expect(groups[0]?.years.some((y) => y.requirement.id === "req_fy23_na")).toBe(false);
  });

  it("never groups a non-financial-year-scoped document type", () => {
    const db = baseDb();
    const groups = financialYearGroups(db, REQUIREMENTS);
    expect(groups.some((g) => g.documentTypeId === "dty_pan")).toBe(false);
  });
});
