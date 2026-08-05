/**
 * The fake backend's object storage — an in-memory implementation of
 * `@domain/storage`'s `StorageAdapter`, standing in for Supabase Storage or
 * an S3-compatible bucket the same way `store.ts` stands in for Postgres.
 *
 * Deliberately NOT part of the persisted `db` object or its localStorage
 * mirror: bytes don't belong there any more than they'd belong in Postgres
 * (see `document.file_path`'s comment in Database/migrations/0005). A
 * refresh loses uploaded bytes in this prototype; the metadata (path, size,
 * version) survives via `db.documents`, which mirrors exactly what a real
 * deployment keeps in the database versus the bucket.
 */

import type { StorageAdapter, StoredObject } from "@domain/storage/index.js";

class InMemoryStorageAdapter implements StorageAdapter {
  private readonly objects = new Map<string, { bytes: Uint8Array; stored: StoredObject }>();

  async put(
    path: string,
    bytes: Uint8Array,
    options?: { contentType?: string },
  ): Promise<StoredObject> {
    const stored: StoredObject = {
      path,
      sizeBytes: bytes.byteLength,
      ...(options?.contentType ? { contentType: options.contentType } : {}),
      storedAt: new Date().toISOString(),
    };
    this.objects.set(path, { bytes, stored });
    return stored;
  }

  async get(path: string): Promise<Uint8Array> {
    const entry = this.objects.get(path);
    if (!entry) {
      throw new Error(`No object at path "${path}".`);
    }
    return entry.bytes;
  }

  async list(prefix: string): Promise<readonly StoredObject[]> {
    return [...this.objects.values()]
      .filter((entry) => entry.stored.path.startsWith(prefix))
      .map((entry) => entry.stored);
  }
}

export const storageAdapter: StorageAdapter = new InMemoryStorageAdapter();
