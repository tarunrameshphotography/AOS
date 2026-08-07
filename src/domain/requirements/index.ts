/**
 * The Document Requirement Engine (Milestone 9, ADR-035).
 *
 * One entry point, matching @domain/products, @domain/lenders, @domain/storage
 * and @domain/permissions, so a consumer imports what requirements MEAN rather
 * than which file they live in.
 *
 * The three pieces:
 *
 *   rules.ts          the evaluator — facts in, requirements out, no database
 *   default-rules.ts  the researched starting rule pack, editable afterwards
 *   financial-year.ts India's April–March year, and which types recur
 *   progress.ts       what the generated set means for the case's score
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
  defaultRuleDocumentTypeCodes,
  findRule,
} from "./default-rules.js";

export {
  ALL_DOCUMENT_TYPES,
  BASE_DOCUMENT_TYPES,
  CUSTOM_DOCUMENT_TYPE_CODE,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORY_HINTS,
  DOCUMENT_CATEGORY_LABELS,
  ENGINE_DOCUMENT_TYPES,
  PRE_ENGINE_DOCUMENT_TYPES,
  allDocumentTypeCodes,
  documentTypeByCode,
  type DocumentCategory,
  type DocumentTypeDefinition,
} from "./document-catalogue.js";

export {
  FINANCIAL_YEAR_DOCUMENT_TYPES,
  financialYearFromStartYear,
  financialYearLabel,
  financialYearOf,
  financialYearStartYear,
  isFinancialYearScoped,
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
