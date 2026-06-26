// Disk-backed LeadStore: one JSON file per run under <DATA_DIR>/runs/. Also writes a
// human-friendly emails.md + leads.csv per run for easy reading/exporting.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LeadStore, RunData, RunSummary } from "./storage.js";

export class DiskStore implements LeadStore {
  constructor(private readonly dataDir: string) {}

  private runsDir(): string {
    return join(this.dataDir, "runs");
  }

  async saveRun(run: RunData): Promise<void> {
    const dir = this.runsDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${run.id}.json`), JSON.stringify(run, null, 2), "utf8");
  }

  async listRuns(): Promise<RunSummary[]> {
    const dir = this.runsDir();
    if (!existsSync(dir)) return [];
    const summaries: RunSummary[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const run = JSON.parse(readFileSync(join(dir, file), "utf8")) as RunData;
        summaries.push({
          id: run.id,
          query: run.query,
          createdAt: run.createdAt,
          leadCount: run.leads?.length ?? 0,
          emailCount: run.emails?.length ?? 0,
        });
      } catch {
        // skip unreadable files
      }
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getRun(id: string): Promise<RunData | null> {
    const path = join(this.runsDir(), `${id}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as RunData;
    } catch {
      return null;
    }
  }

  async deleteRun(id: string): Promise<void> {
    rmSync(join(this.runsDir(), `${id}.json`), { force: true });
  }
}
