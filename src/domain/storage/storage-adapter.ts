/**
 * The storage abstraction every document write and read goes through.
 *
 * Metadata (owner, type, version, verification) lives in the application
 * database; bytes live behind this interface, in object storage. The split
 * mirrors `document.file_path`'s column comment in
 * Database/migrations/0005: "A reference into object storage. The bytes are
 * not in Postgres; storage-level access is governed by the same permission
 * model."
 *
 * Nothing in this file talks to a real backend, and that is the point:
 *  - `Frontend/src/fake/storage.ts` implements it in memory, standing in for
 *    object storage the same way `store.ts` stands in for Postgres.
 *  - A Supabase Storage or S3-compatible adapter implements it later without
 *    touching `buildStoragePath`, `uploadDocument`, or any caller — the path
 *    a document lives at does not change when the backend behind it does.
 *  - Future ingestion paths (OCR output, email attachments, WhatsApp media,
 *    bulk import) are just more callers of `put`, each resolving a
 *    `DocumentOwner` and a path exactly the way an interactive upload does.
 *    None of them need their own storage logic or their own layout.
 */

export interface StoredObject {
  readonly path: string;
  readonly sizeBytes: number;
  readonly contentType?: string;
  readonly storedAt: string;
}

export interface StorageAdapter {
  /**
   * Writes bytes at `path`. Paths are effectively append-only: a replacement
   * document gets a new path (via `buildStoragePath`'s version segment)
   * rather than reusing the old one, so nothing already written is ever
   * overwritten (BR-031).
   */
  put(
    path: string,
    bytes: Uint8Array,
    options?: { contentType?: string },
  ): Promise<StoredObject>;

  get(path: string): Promise<Uint8Array>;

  /** Every object whose path starts with `prefix` — e.g. every version of one
   * document, or everything under one owner. */
  list(prefix: string): Promise<readonly StoredObject[]>;
}
