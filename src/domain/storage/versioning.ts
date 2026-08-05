/**
 * Document versioning — never overwritten, always traceable (BR-031).
 *
 * A replacement document does not delete or mutate the one it replaces; it is
 * a new row at a new storage path (see `buildStoragePath`'s version segment)
 * that points back at what it supersedes. That single backward link is enough
 * to reconstruct "what did this look like at each point in time" without a
 * separate history table.
 */

export interface VersionInfo {
  readonly version: number;
}

/** 1 for a first upload against a requirement; one more than whatever it
 * replaces otherwise. There is deliberately no way to skip a version or reuse
 * one — the number is a count of uploads, not a label anyone chooses. */
export function nextVersion(previous?: VersionInfo): number {
  return previous ? previous.version + 1 : 1;
}

export interface SupersessionLink {
  readonly id: string;
  readonly supersedesDocumentId?: string;
}

/**
 * Walks the supersedes chain back from the latest version, most recent
 * first — the audit history for one logical document. `documents` may be any
 * superset (e.g. every document ever uploaded for a case); only the ones
 * reachable from `latestDocumentId` are returned.
 *
 * Guards against a cyclic `supersedes_document_id` (which
 * `document_supersedes_is_not_self`, 0005, only rules out for a single
 * self-reference, not a longer loop) rather than looping forever on
 * corrupted data.
 */
export function versionHistory(
  documents: readonly SupersessionLink[],
  latestDocumentId: string,
): readonly string[] {
  const byId = new Map(documents.map((document) => [document.id, document]));
  const chain: string[] = [];
  const seen = new Set<string>();

  let current = byId.get(latestDocumentId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current.id);
    current = current.supersedesDocumentId ? byId.get(current.supersedesDocumentId) : undefined;
  }

  return chain;
}
