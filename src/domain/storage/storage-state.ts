/**
 * Distinguishing why a document's bytes can't be shown, from the three facts
 * that are actually knowable: whether the storage backend answered at all,
 * what root it is currently configured with, and what root was configured
 * when this document was written (`DocumentFile.storageRoot`).
 *
 * "File missing on disk" and "the storage root was reconfigured since this
 * was uploaded" look identical to a user (a broken preview) but call for
 * different fixes — one is a genuinely lost file, the other means every
 * document written under the old root is still sitting there, just not
 * where the backend is currently looking.
 */

export type StorageFileState = "ok" | "missing" | "root-changed";

export function classifyStorageState(input: {
  /** The root recorded on the document at upload time. Undefined for
   * documents uploaded before this was tracked — such a document can only
   * ever read as "ok" or "missing", never "root-changed". */
  readonly documentStorageRoot?: string;
  readonly currentStorageRoot: string;
  readonly exists: boolean;
}): StorageFileState {
  if (input.documentStorageRoot && input.documentStorageRoot !== input.currentStorageRoot) {
    return "root-changed";
  }
  return input.exists ? "ok" : "missing";
}
