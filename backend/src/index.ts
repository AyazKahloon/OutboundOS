// Worker entry point. Boots the BullMQ worker that processes the agent pipeline.
import "./lib/env.js"; // must be first — loads root .env before other modules read it
import { startPipelineWorker } from "./queue/pipeline.worker.js";

async function main() {
  console.log("[backend] starting OutboundOS pipeline worker…");
  startPipelineWorker();
}

main().catch((err) => {
  console.error("[backend] fatal:", err);
  process.exit(1);
});
