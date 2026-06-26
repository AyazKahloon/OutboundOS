// Single entry point bundled into the desktop app (esbuild → desktop/backend.cjs).
// Exposes exactly what the Electron main process needs.
export { scrapeAndGenerate, processCsvFile, FOLLOWUP_GAP_DAYS, MAX_SEQUENCE_STEPS } from "./service.js";
export { createStore } from "./storage/index.js";
export { isMailboxConfigured, verifyMailbox, sendEmail, checkReplies } from "./mailer.js";
export { generateFollowup } from "./agents/followup.agent.js";
