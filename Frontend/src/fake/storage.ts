/**
 * The fake backend's object storage — talks to the local document storage
 * backend (`Backend/storage-server.mjs`) over HTTP, implementing
 * `@domain/storage`'s `StorageAdapter` the same way a Supabase Storage or
 * S3-compatible adapter would later: nothing outside this file knows bytes
 * live on disk under a configurable root rather than in a bucket.
 *
 * Metadata (owner, type, version, verification) still lives in `db.documents`
 * (`store.ts`'s stand-in for Postgres); only bytes go through this adapter,
 * exactly mirroring `document.file_path`'s column comment in
 * Database/migrations/0005.
 */

import type { StorageAdapter, StoredObject } from "@domain/storage/index.js";

const BASE_URL =
  (import.meta.env.VITE_STORAGE_SERVER_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://127.0.0.1:4319";

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}

class LocalFsStorageAdapter implements StorageAdapter {
  async put(
    path: string,
    bytes: Uint8Array,
    options?: { contentType?: string },
  ): Promise<StoredObject> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/objects?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: options?.contentType ? { "Content-Type": options.contentType } : {},
        body: bytes as BodyInit,
      });
    } catch {
      throw new Error(
        "Could not reach the local document storage backend. Is it running (npm run storage-server)?",
      );
    }
    if (!response.ok) {
      throw new Error(await parseErrorMessage(response, `Failed to store "${path}".`));
    }
    return (await response.json()) as StoredObject;
  }

  async get(path: string): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/objects?path=${encodeURIComponent(path)}`);
    } catch {
      throw new Error(
        "Could not reach the local document storage backend. Is it running (npm run storage-server)?",
      );
    }
    if (!response.ok) {
      throw new Error(await parseErrorMessage(response, `No object at path "${path}".`));
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async list(prefix: string): Promise<readonly StoredObject[]> {
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/objects/list?prefix=${encodeURIComponent(prefix)}`);
    } catch {
      throw new Error(
        "Could not reach the local document storage backend. Is it running (npm run storage-server)?",
      );
    }
    if (!response.ok) {
      throw new Error(await parseErrorMessage(response, `Failed to list "${prefix}".`));
    }
    return (await response.json()) as readonly StoredObject[];
  }
}

export const storageAdapter: StorageAdapter = new LocalFsStorageAdapter();

/** Whether an object actually exists on disk — for the "file missing" warning
 * on a document's detail view, without downloading its bytes just to check. */
export async function objectExists(path: string): Promise<boolean> {
  const entries = await storageAdapter.list(path);
  return entries.some((entry) => entry.path === path);
}

export interface StorageConfig {
  readonly root: string;
}

/** The configured storage root (e.g. `C:\AOS\Data`), for display alongside a
 * document's storage path. Falls back to a message explaining the backend
 * isn't reachable rather than throwing, since this is read for display only. */
export async function getStorageConfig(): Promise<StorageConfig> {
  const response = await fetch(`${BASE_URL}/config`);
  if (!response.ok) {
    throw new Error("Could not read the storage configuration.");
  }
  return (await response.json()) as StorageConfig;
}

export interface OpenFolderResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** Opens the folder containing `path` in Windows Explorer via the local
 * storage backend — a browser tab cannot do this itself. */
export async function openStorageFolder(path: string): Promise<OpenFolderResult> {
  try {
    const response = await fetch(`${BASE_URL}/open-folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    return (await response.json()) as OpenFolderResult;
  } catch {
    return {
      ok: false,
      message: "Could not reach the local document storage backend to open the folder.",
    };
  }
}
