/**
 * The Document Requirement Engine (Milestone 9, ADR-035).
 *
 * One entry point, matching @domain/products, @domain/lenders, @domain/storage
 * and @domain/permissions, so a consumer imports what requirements MEAN rather
 * than which file they live in.
 *
 * The pieces:
 *
 *   document-catalogue.ts every document type AOS can ask for, defined once
 *   rules.ts              the evaluator — facts in, requirements out, no database
 *   default-rules.ts      the researched starting rule pack, editable afterwards
 *   financial-year.ts     India's April–March year
 *   progress.ts           what the generated set means for the case's score
 */

export {
  CONDITION_OPERATORS,
  CONSTRUCTION_STAGES,
  FACT_PATHS,
  evaluateCondition,
  evaluateRules,
  explainRequirement,
  resolveFact,
  ruleMatches,
  type CaseFacts,
  type ConditionOperator,
  type ConstructionStage,
  type FactPath,
  type FactValue,
  type GeneratedRequirement,
  type PartyFacts,
  type PropertyFacts,
  type RequirementRule,
  type RuleCondition,
  type RuleScope,
} from "./rules.js";

export {
  DEFAULT_REQUIREMENT_RULES,
  activeRulesAskingForNonCustomerDocuments,
  defaultRuleDocumentTypeCodes,
} from "./default-rules.js";

export {
  CUSTOM_DOCUMENT_TYPE_CODE,
  DOCUMENT_ARTIFACT_KINDS,
  DOCUMENT_CATALOGUE,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_HINTS,
  DOCUMENT_CATEGORY_LABELS,
  DOCUMENT_OWNER_KINDS,
  DOCUMENT_TYPES_BY_CODE,
  FINANCIAL_YEAR_DOCUMENT_TYPES,
  allDocumentTypeCodes,
  artifactKindOf,
  assessmentYearLabel,
  documentRowLabel,
  documentTypeByCode,
  isCustomerDocument,
  isFinancialYearScoped,
  type DocumentArtifactKind,
  type DocumentCategory,
  type DocumentOwnerKind,
  type DocumentTypeDefinition,
  type PeriodKind,
} from "./document-catalogue.js";

export {
  financialYearFromStartYear,
  financialYearLabel,
  financialYearOf,
  financialYearStartYear,
  recentCompletedFinancialYears,
  recentFinancialYears,
  type FinancialYear,
} from "./financial-year.js";

export {
  OUTSTANDING_STATUSES,
  REQUIREMENT_STATUSES,
  summariseProgress,
  type ProgressSummary,
  type Requirement,
  type RequirementStatus,
} from "./progress.js";
