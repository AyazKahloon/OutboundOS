// Storage abstraction. Today it's backed by JSON files on disk (DiskStore); swapping to a
// database later means writing one new class that implements LeadStore — nothing else changes.
import type { PlaceLead } from "../scrapers/gmaps-reviews.js";
import type { GeneratedEmail } from "../service.js";

// One scrape/generate session.
export interface RunData {
  id: string;
  query: string;
  createdAt: string; // ISO
  leads: PlaceLead[];
  emails?: GeneratedEmail[];
}

export interface RunSummary {
  id: string;
  query: string;
  createdAt: string;
  leadCount: number;
  emailCount: number;
}

export interface LeadStore {
  saveRun(run: RunData): Promise<void>;
  listRuns(): Promise<RunSummary[]>;
  getRun(id: string): Promise<RunData | null>;
  deleteRun(id: string): Promise<void>;
}
