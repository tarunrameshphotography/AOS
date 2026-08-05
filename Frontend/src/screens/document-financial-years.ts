/**
 * Groups a case's financial-year-scoped requirement rows by document type and
 * subject, for the "Financial years" panel on the case's Documents tab.
 *
 * Pulled out of CaseDetail.tsx because it is pure computation over the fake
 * database, not rendering — the same shape a real backend's requirement
 * listing would need to group by.
 */

import { financialYearOf, isFinancialYearScoped } from "@domain/requirements/financial-year.js";

import type { Database, DocumentRequirement, Id } from "../fake/types.js";
import { partyName } from "../lib.js";

export interface FyGroup {
  key: string;
  documentTypeId: Id;
  documentTypeName: string;
  casePartyId?: Id;
  casePropertyId?: Id;
  subjectLabel: string;
  years: Array<{ requirement: DocumentRequirement; label: string }>;
}

export function financialYearGroups(db: Database, requirements: DocumentRequirement[]): FyGroup[] {
  const groups = new Map<string, FyGroup>();

  for (const requirement of requirements) {
    if (requirement.status === "not_applicable" || !requirement.periodStart) {
      continue;
    }
    const type = db.documentTypes.find((t) => t.id === requirement.documentTypeId);
    if (!type || !isFinancialYearScoped(type.code)) {
      continue;
    }

    const key = [
      requirement.documentTypeId,
      requirement.requiredOfCasePartyId ?? "-",
      requirement.requiredOfCasePropertyId ?? "-",
    ].join("|");

    const group =
      groups.get(key) ??
      ({
        key,
        documentTypeId: requirement.documentTypeId,
        documentTypeName: type.name,
        ...(requirement.requiredOfCasePartyId ? { casePartyId: requirement.requiredOfCasePartyId } : {}),
        ...(requirement.requiredOfCasePropertyId
          ? { casePropertyId: requirement.requiredOfCasePropertyId }
          : {}),
        subjectLabel: requirement.requiredOfCasePartyId
          ? partyName(db, requirement.requiredOfCasePartyId)
          : "The firm",
        years: [],
      } satisfies FyGroup);

    group.years.push({
      requirement,
      label: financialYearOf(new Date(requirement.periodStart)).label,
    });
    groups.set(key, group);
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.years.sort((a, b) => b.label.localeCompare(a.label));
  }
  return result;
}
