/**
 * The lender catalogue — institutions, branches and contacts, for the "which
 * bank does this go to" picker on the Banks tab.
 *
 * Same shape as `useReference`/`useUsers` (`Frontend/src/api/catalogue.ts`):
 * fetched once per screen, looked up by id rather than re-fetched per row.
 */

import { useMemo } from "react";

import { useApiQuery } from "./hooks.js";
import type { ApiLender, ApiLenderBranch } from "./types.js";

export function useLenders() {
  const query = useApiQuery<readonly ApiLender[]>("/lenders");

  return useMemo(() => {
    const lenders = query.data ?? [];
    const branchesById = new Map<string, ApiLenderBranch & { lenderName: string }>();
    for (const lender of lenders) {
      for (const branch of lender.branches) {
        branchesById.set(branch.id, { ...branch, lenderName: lender.name });
      }
    }

    return {
      loading: query.loading,
      error: query.error,
      lenders,
      /** "HDFC Bank — RS Puram", or an em dash for a branch that no longer
       * resolves (deactivated since the submission was made). */
      branchLabel: (branchOrganisationId: string | null | undefined): string => {
        if (!branchOrganisationId) return "—";
        const branch = branchesById.get(branchOrganisationId);
        if (!branch) return "—";
        return branch.name.startsWith(branch.lenderName)
          ? branch.name
          : `${branch.lenderName} — ${branch.name}`;
      },
    };
  }, [query.data, query.loading, query.error]);
}
