/**
 * An in-memory `StorageAdapter`, used only by tests (see `store.test.ts`'s
 * `vi.doMock`). Vitest's node environment has no local storage backend to
 * talk to and shouldn't need one just to assert that `uploadDocument` writes
 * bytes at the path `buildStoragePath` computed — that is a pure round-trip
 * this fake satisfies without touching a disk or a network socket.
 */

import type { StorageAdapter, StoredObject } from "@domain/storage/index.js";

/** Matches `getStorageConfig`'s shape from `storage.ts`, without the fetch. */
export interface MockStorageConfig {
  readonly root: string;
}

export const MOCK_STORAGE_ROOT = "mock://storage-root";

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

/**
 * A full stand-in for `./storage.js`, for `vi.doMock("./storage.js", ...)`.
 *
 * `store.ts` imports `objectExists`/`getStorageConfig` alongside
 * `storageAdapter` (upload-time verification, Storage reliability milestone)
 * — mocking only `storageAdapter` leaves those undefined and breaks every
 * upload test, so this is the one factory every such mock should use.
 *
 * `overrides` lets a specific test simulate a write that reports success but
 * cannot be read back (`objectExists: async () => false`), or a storage root
 * that has moved since upload (`getStorageConfig: async () => ({ root: "..." })`).
 */
export function createStorageModule(overrides?: {
  objectExists?: (path: string) => Promise<boolean>;
  getStorageConfig?: () => Promise<MockStorageConfig>;
}): {
  storageAdapter: InMemoryStorageAdapter;
  objectExists: (path: string) => Promise<boolean>;
  getStorageConfig: () => Promise<MockStorageConfig>;
} {
  const storageAdapter = new InMemoryStorageAdapter();
  return {
    storageAdapter,
    objectExists:
      overrides?.objectExists ??
      (async (path: string) => {
        const entries = await storageAdapter.list(path);
        return entries.some((entry) => entry.path === path);
      }),
    getStorageConfig: overrides?.getStorageConfig ?? (async () => ({ root: MOCK_STORAGE_ROOT })),
  };
}
