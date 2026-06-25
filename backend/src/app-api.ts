// Single entry point bundled into the desktop app (esbuild → desktop/backend.cjs).
// Exposes exactly what the Electron main process needs.
export { scrapeAndGenerate, processCsvFile } from "./service.js";
export { createStore } from "./storage/index.js";
export { isMailboxConfigured, verifyMailbox, sendEmail } from "./mailer.js";
