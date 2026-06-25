// Campaign-independent config for the agents. TODO: move offer/sender to be campaign-driven later.

export const sender = {
  name: process.env.SENDER_NAME ?? "TODO_YOUR_NAME",
  company: process.env.SENDER_COMPANY ?? "TODO_YOUR_COMPANY",
};

// What you're pitching. The writer agent builds the email around this.
export const offer =
  process.env.OFFER ??
  "TODO: describe your offer in 1-3 sentences — what you do, the concrete value, and the call to action.";

// Groq model ids (override via env if needed). Groq is the ONLY paid dependency —
// crawling and review-gathering are done in-house with a local headless browser.
export const models = {
  researcher: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
  reviewsAnalyst: process.env.GROQ_REVIEWS_MODEL ?? "llama-3.3-70b-versatile",
  writer: process.env.GROQ_WRITER_MODEL ?? "llama-3.3-70b-versatile",
};
