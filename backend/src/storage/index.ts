// Storage factory. Returns the disk-backed store today; swap this single line for a
// database-backed store later (e.g. return new DbStore(...)) without touching callers.
import { DATA_DIR } from "../lib/paths.js";
import { DiskStore } from "./disk-store.js";
import type { LeadStore } from "./storage.js";

export type { LeadStore, RunData, RunSummary } from "./storage.js";

export function createStore(): LeadStore {
  return new DiskStore(DATA_DIR);
}
