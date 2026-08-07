/**
 * Drafts — half-finished typing that survives navigation.
 *
 * WHY THIS EXISTS
 *
 * The case screen's four tabs mount and unmount as you switch between them.
 * Every `useState` in them is therefore erased by clicking "Documents" and
 * coming back: a half-written note, a rejection reason, a custom document
 * being described. Nobody loses much, but everybody learns not to type
 * anything they are not ready to save — which is the habit that makes people
 * keep the real notes somewhere else.
 *
 * So the rule for this milestone (Part 7) is that the user should never
 * wonder whether their work was kept. Two halves to that:
 *
 *   - Anything SAVED goes through a store mutation, is written to the case,
 *     and says so.
 *   - Anything merely TYPED is kept here, keyed by case and field, and comes
 *     back when they return. It is explicitly NOT part of the case: a draft
 *     is not a note, and this module writes nothing to `db`.
 *
 * Persisted to localStorage so a refresh does not lose it either. Cleared by
 * the code that successfully saves it — a draft that outlives its save turns
 * into a ghost of text the user already dealt with.
 */

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "aos.drafts.v1";

type Drafts = Record<string, string>;

function read(): Drafts {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Drafts) : {};
  } catch {
    // A corrupt or unavailable store is not worth an error boundary; the cost
    // of getting this wrong is one lost half-sentence.
    return {};
  }
}

let drafts: Drafts = typeof localStorage === "undefined" ? {} : read();
const listeners = new Set<() => void>();

function write(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    /* quota or private mode — the in-memory copy still works for this session */
  }
  for (const listener of listeners) listener();
}

export function getDraft(key: string): string {
  return drafts[key] ?? "";
}

export function setDraft(key: string, value: string): void {
  if (value === "") {
    if (!(key in drafts)) return;
    const { [key]: _removed, ...rest } = drafts;
    drafts = rest;
  } else {
    if (drafts[key] === value) return;
    drafts = { ...drafts, [key]: value };
  }
  write();
}

export function clearDraft(key: string): void {
  setDraft(key, "");
}

/** Clear a whole group at once — every field of one dialog, say. */
export function clearDrafts(prefix: string): void {
  const next: Drafts = {};
  let changed = false;
  for (const [key, value] of Object.entries(drafts)) {
    if (key.startsWith(prefix)) changed = true;
    else next[key] = value;
  }
  if (!changed) return;
  drafts = next;
  write();
}

/**
 * `useState` that remembers. Same shape, so a component adopts it by changing
 * one line, which is the only reason it will actually get adopted.
 */
export function useDraft(key: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => getDraft(key));

  // Re-read when the key changes — the same component instance is reused for
  // a different case or a different requirement.
  useEffect(() => {
    setValue(getDraft(key));
  }, [key]);

  useEffect(() => {
    const listener = (): void => setValue(getDraft(key));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [key]);

  const set = useCallback(
    (next: string) => {
      setValue(next);
      setDraft(key, next);
    },
    [key],
  );

  return [value, set];
}
