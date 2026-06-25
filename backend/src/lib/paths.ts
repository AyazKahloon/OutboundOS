// Where the app reads/writes data. The desktop app always sets OUTBOUNDOS_DATA_DIR (to a
// folder on F:). For the CLI it falls back to the repo root.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.url works under tsx/ESM (the CLI). When this module is bundled to CJS for the
// desktop app it isn't available — but the app always provides OUTBOUNDOS_DATA_DIR, so the
// fallback below is never needed there; the try/catch keeps it from throwing regardless.
function repoRootFallback(): string {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  } catch {
    return process.cwd();
  }
}

export const DATA_DIR = process.env.OUTBOUNDOS_DATA_DIR
  ? resolve(process.env.OUTBOUNDOS_DATA_DIR)
  : repoRootFallback();
