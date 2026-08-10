/**
 * Server-side client for the local document storage backend
 * (`Backend/storage-server.mjs`), implementing `@domain/storage`'s
 * `StorageAdapter` from Node rather than the browser.
 *
 * `Frontend/src/fake/storage.ts` already implements this interface this way,
 * over the same HTTP API — this is the same adapter, from the other process
 * that is allowed to hold write authority: the API server checks
 * `document.upload` / `document.verify` before a byte is ever written, which
 * the browser talking to `storage-server.mjs` directly cannot do. Real
 * document uploads go browser -> API server -> storage server; the browser
 * no longer writes bytes on its own.
 */

import type { StorageAdapter, StoredObject } from "@domain/storage/index.js";

const BASE_URL =
  (process.env.AOS_STORAGE_SERVER_URL ?? "http://127.0.0.1:4319").replace(/\/$/, "");

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string };
    return body.message ?? fallback;
  } catch {
    return fallback;
  }
}

class HttpStorageAdapter implements StorageAdapter {
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
        body: new Uint8Array(bytes),
      });
    } catch {
      throw new Error("Could not reach the document storage backend.");
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
      throw new Error("Could not reach the document storage backend.");
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
      throw new Error("Could not reach the document storage backend.");
    }
    if (!response.ok) {
      throw new Error(await parseErrorMessage(response, `Failed to list "${prefix}".`));
    }
    return (await response.json()) as readonly StoredObject[];
  }
}

export const storageAdapter: StorageAdapter = new HttpStorageAdapter();

/** The object's content type, read straight off the storage server's response
 * headers, for streaming a download back to the browser without guessing. */
export async function getObjectWithContentType(
  path: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/objects?path=${encodeURIComponent(path)}`);
  } catch {
    throw new Error("Could not reach the document storage backend.");
  }
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, `No object at path "${path}".`));
  }
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  return { bytes: new Uint8Array(await response.arrayBuffer()), contentType };
}
