/**
 * The lending product catalogue (Milestone 7, ADR-032).
 *
 * One entry point, matching @domain/storage and @domain/permissions, so a
 * consumer imports what the catalogue means rather than which file it lives
 * in.
 */

export {
  describeAmount,
  describeAmountRange,
  describeTenure,
  filterProducts,
  isNotApplicable,
  isOfferable,
  isRequired,
  matchesFilter,
  productAvailability,
  supersededCodes,
  type ApplicabilityCode,
  type LendingProduct,
  type ProductAvailability,
  type ProductFilter,
} from "./catalogue.js";
