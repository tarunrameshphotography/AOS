/**
 * Automatic document organisation (Issue #13).
 *
 * Three files, one job each:
 *
 * - `path.ts`             — resolves a document's owner and computes where it
 *                            lives, deterministically, with no user choice.
 * - `versioning.ts`       — version numbers and the supersedes chain that
 *                            gives replacement and audit history.
 * - `storage-adapter.ts`  — the interface bytes are read and written through,
 *                            implemented today by the fake backend and later
 *                            by a real object-storage adapter.
 */

export {
  buildStoragePath,
  resolveDocumentOwner,
  type DocumentOwner,
  type DocumentOwnerFields,
  type DocumentOwnerKind,
  type DocumentPathInput,
} from "./path.js";

export {
  nextVersion,
  versionHistory,
  type SupersessionLink,
  type VersionInfo,
} from "./versioning.js";

export {
  type StorageAdapter,
  type StoredObject,
} from "./storage-adapter.js";
