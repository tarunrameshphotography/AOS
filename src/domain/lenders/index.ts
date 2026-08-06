/**
 * The lender catalogue (Milestone 8, ADR-034).
 *
 * One entry point, matching @domain/products, @domain/storage and
 * @domain/permissions, so a consumer imports what the catalogue means rather
 * than which file it lives in.
 */

export {
  branchesOf,
  describeBranchCount,
  describeInstitution,
  describeTurnaround,
  filterLenders,
  insightsFor,
  isAvailable,
  isLodgeable,
  lenderAvailability,
  matchesFilter,
  submissionRulesFor,
  supportedProductCodes,
  type BranchStatus,
  type InsightGroup,
  type LenderAvailability,
  type LenderBranch,
  type LenderContext,
  type LenderFilter,
  type LenderInsight,
  type LenderInstitution,
  type RelationshipManager,
  type SubmissionRule,
  type SupportedProduct,
} from "./catalogue.js";
