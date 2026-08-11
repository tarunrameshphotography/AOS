/**
 * Master data over the API — document types, rejection reasons, document
 * requirement rules and operational thresholds (Stage 4 Item 4).
 *
 * Same shape as `catalogue.ts`/`lenders.ts`: one `useApiQuery` per resource,
 * fetched once per screen. Mutations go through `api()` directly, the same
 * way `UserManagement.tsx` calls it for overrides — there is no generic
 * "master data mutation" hook because each of the four categories edits
 * different fields (`Backend/master-data.ts`'s four update functions).
 *
 * PRODUCTS AND LENDERS ARE NOT HERE. They stay read-only this stage
 * (`useReference`, `useLenders` in `catalogue.ts`/`lenders.ts`) — this file
 * is only the four categories Item 4 made server-authoritative.
 */

import { useMemo } from "react";

import { useApiQuery } from "./hooks.js";
import type {
  ApiDocumentRequirementRule,
  ApiDocumentType,
  ApiRejectionReason,
  ApiThreshold,
} from "./types.js";

export function useDocumentTypes() {
  const query = useApiQuery<readonly ApiDocumentType[]>("/master-data/document-types");
  return useMemo(() => {
    const documentTypes = query.data ?? [];
    const byCode = new Map(documentTypes.map((t) => [t.code, t]));
    return { ...query, documentTypes, nameForCode: (code: string) => byCode.get(code)?.name ?? code };
  }, [query]);
}

export function useRejectionReasons() {
  const query = useApiQuery<readonly ApiRejectionReason[]>("/master-data/rejection-reasons");
  return useMemo(() => ({ ...query, rejectionReasons: query.data ?? [] }), [query]);
}

export function useDocumentRequirementRules() {
  const query = useApiQuery<readonly ApiDocumentRequirementRule[]>("/master-data/document-rules");
  return useMemo(() => ({ ...query, rules: query.data ?? [] }), [query]);
}

export function useThresholds() {
  const query = useApiQuery<readonly ApiThreshold[]>("/master-data/thresholds");
  return useMemo(() => ({ ...query, thresholds: query.data ?? [] }), [query]);
}
