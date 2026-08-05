import { useSyncExternalStore } from "react";

import { getDb, subscribe } from "./store.js";
import type { Database } from "./types.js";

/** The whole database, re-rendering whatever reads it when any write commits. */
export function useDatabase(): Database {
  return useSyncExternalStore(subscribe, getDb, getDb);
}
