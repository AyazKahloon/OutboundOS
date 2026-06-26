// Campaign-independent config for the agents. TODO: move offer/sender to be campaign-driven later.

export const sender = {
  name: process.env.SENDER_NAME ?? "TODO_YOUR_NAME",
  company: process.env.SENDER_COMPANY ?? "TODO_YOUR_COMPANY",
};

// What you're pitching — the menu of services the email picks the best fit from.
const KODWORKS_OFFER =
  "KodWorks is a software development and automation agency. We build custom software (web apps, " +
  "mobile apps and bespoke internal tools) and automation that removes manual, repetitive work: " +
  "AI chatbots, WhatsApp bots, and voice agents that answer and make calls for support, lead " +
  "capture and follow up and push leads into your CRM, plus document, workflow and data entry " +
  "automation. We also help businesses get more Google reviews. The goal is to stop losing ROI on " +
  "inefficient processes and stop wasting time on tasks that should run automatically, so teams " +
  "can focus on growth.";
export const offer = process.env.OFFER ?? KODWORKS_OFFER;

// Groq model ids (override via env if needed). Groq is the ONLY paid dependency —
// crawling and review-gathering are done in-house with a local headless browser.
// Default is openai/gpt-oss-120b (llama-3.3-70b-versatile was deprecated by Groq).
// The email is written by `models.writer` (the single composer call).
const DEFAULT_MODEL = "openai/gpt-oss-120b";
export const models = {
  researcher: process.env.GROQ_MODEL ?? DEFAULT_MODEL,
  reviewsAnalyst: process.env.GROQ_REVIEWS_MODEL ?? DEFAULT_MODEL,
  writer: process.env.GROQ_WRITER_MODEL ?? DEFAULT_MODEL,
};
