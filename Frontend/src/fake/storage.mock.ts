/**
 * An in-memory `StorageAdapter`, used only by tests (see `store.test.ts`'s
 * `vi.doMock`). Vitest's node environment has no local storage backend to
 * talk to and shouldn't need one just to assert that `uploadDocument` writes
 * bytes at the path `buildStoragePath` computed — that is a pure round-trip
 * this fake satisfies without touching a disk or a network socket.
 */

import type { StorageAdapter, StoredObject } from "@domain/storage/index.js";

export class InMemoryStorageAdapter implements StorageAdapter {
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
