/**
 * The lookups every migrated screen needs, over data the API owns.
 *
 * A case row carries a `loanProductId`, an `ownerUserId` and a
 * `referralSourceId`. Turning those into words used to be `lib.ts`'s
 * `productLabel(db, …)` and `ownerName(db, …)`, reading arrays the store held
 * in memory. Those arrays are now server-side, so the lookups become hooks —
 * fetched once per screen and shared through the query key.
 *
 * WHY THESE ARE NOT ONE `useEverything()`: each screen states what it needs,
 * and a screen that does not name owners does not fetch the user list. That
 * was invisible when the whole database was a synchronous object; it is worth
 * being explicit about now that each one is a request.
 */

import { useMemo } from "react";

import { useApiQuery } from "./hooks.js";
import type { ApiReference, ApiUser } from "./types.js";

/** The loan-product and referral-source catalogues, with lookups by id. */
export function useReference() {
  const query = useApiQuery<ApiReference>("/reference");

  return useMemo(() => {
    const products = query.data?.loanProducts ?? [];
    const sources = query.data?.referralSources ?? [];
    const productById = new Map(products.map((p) => [p.id, p]));
    const sourceById = new Map(sources.map((s) => [s.id, s]));

    // The intake dropdowns. A deactivated master-data row still labels the
    // cases that already reference it, so both lists travel: `selectable*` is
    // what a new case may choose, the full list is what an old one is named
    // by — the same distinction `selectableProducts` already draws.
    const employmentTypes = query.data?.employmentTypes ?? [];
    const borrowerTypes = query.data?.borrowerTypes ?? [];
    const businessConstitutions = query.data?.businessConstitutions ?? [];
    const propertyTypes = query.data?.propertyTypes ?? [];

    return {
      loading: query.loading,
      error: query.error,
      loanProducts: products,
      referralSources: sources,
      employmentTypes,
      borrowerTypes,
      businessConstitutions,
      propertyTypes,
      productById: (id: string | null | undefined) => (id ? productById.get(id) : undefined),
      /** Products a new case may be opened against. Deactivated ones still
       * label existing cases; they are just not offered again. */
      selectableProducts: products.filter((p) => p.isActive),
      selectableSources: sources.filter((s) => s.isActive),
      /** "Home Loan · Home Loan — Purchase", or an em dash. Never the raw id:
       * a uuid on a case screen is worse than admitting we cannot name it. */
      productLabel: (id: string | null | undefined): string =>
        (id ? productById.get(id)?.label : undefined) ?? "—",
      sourceName: (id: string | null | undefined): string | undefined =>
        id ? sourceById.get(id)?.name : undefined,
    };
  }, [query.data, query.loading, query.error]);
}

/**
 * Everyone with an account — for owner names and the owner filter.
 *
 * `user.read` is held at `all` by every role, deliberately: colleagues' names
 * appear on every case, and without it a case owner would be unrenderable.
 */
export function useUsers() {
  const query = useApiQuery<readonly ApiUser[]>("/users");

  return useMemo(() => {
    const users = query.data ?? [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      loading: query.loading,
      error: query.error,
      users,
      activeUsers: users.filter((u) => u.isActive),
      ownerName: (id: string | null | undefined): string =>
        (id ? byId.get(id)?.fullName : undefined) ?? "Unassigned",
      userRoles: (id: string | null | undefined) => (id ? (byId.get(id)?.roles ?? []) : []),
    };
  }, [query.data, query.loading, query.error]);
}
