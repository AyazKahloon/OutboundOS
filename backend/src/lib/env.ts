// Loads the repo-root .env regardless of the process cwd.
// Import this FIRST (before any module that reads process.env at load time, e.g. ../config).
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
config({ path: resolve(repoRoot, ".env") });
