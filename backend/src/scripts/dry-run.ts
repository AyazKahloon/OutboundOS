// Manually test the FULL in-house pipeline on one business WITHOUT touching DB or queue.
// Crawls the site + scrapes Google reviews ourselves, then research → analysis → writer.
// Usage: pnpm --filter @outboundos/backend dry-run "Business Name" "https://site.com" "Street, City, ST" "Contact Name"
import "../lib/env.js"; // must be first — loads root .env before ../config reads it
import { crawlSite } from "../scrapers/crawler.js";
import { scrapeGoogleReviews } from "../scrapers/gmaps-reviews.js";
import { researcherAgent } from "../agents/researcher.agent.js";
import { reviewsAnalystAgent } from "../agents/reviews-analyst.agent.js";
import { writerAgent } from "../agents/writer.agent.js";
import { closeBrowser } from "../lib/browser.js";
import type { PipelineState } from "../pipeline/pipeline.js";

const state: PipelineState = {
  leadId: "dry-run",
  companyName: process.argv[2] ?? "Absolute Trust Counsel",
  companyWebsite: process.argv[3] ?? "https://absolutetrustcounsel.com",
  address: process.argv[4] ?? "Walnut Creek, CA",
  decisionMakerName: process.argv[5] ?? "",
  siteMarkdown: "",
  reviews: [],
  reviewsMeta: null,
  researchJson: null,
  reviewsJson: null,
  emailSubject: null,
  emailDraft: null,
  error: null,
};

try {
  console.log(`\n=== Crawling ${state.companyWebsite} ===`);
  if (state.companyWebsite) {
    const crawl = await crawlSite(state.companyWebsite);
    state.siteMarkdown = crawl.combinedMarkdown;
    console.log(`crawled ${crawl.pages.length} pages, ${state.siteMarkdown.length} chars`);
  }

  console.log(`\n=== Scraping Google reviews for "${state.companyName}" ===`);
  const rev = await scrapeGoogleReviews({ name: state.companyName, address: state.address });
  state.reviews = rev.reviews;
  state.reviewsMeta = { averageRating: rev.averageRating, totalReviews: rev.totalReviews };
  console.log(`rating ${rev.averageRating ?? "?"}, ${rev.reviews.length} reviews pulled${rev.note ? ` — ${rev.note}` : ""}`);

  console.log(`\n=== Researching ===`);
  Object.assign(state, await researcherAgent(state));
  console.log(JSON.stringify(state.researchJson, null, 2));

  console.log(`\n=== Analyzing reviews ===`);
  Object.assign(state, await reviewsAnalystAgent(state));
  console.log(JSON.stringify(state.reviewsJson, null, 2));

  console.log(`\n=== Writing email ===`);
  Object.assign(state, await writerAgent(state));
  if (state.error) console.error("error:", state.error);
  console.log("\nSubject:", state.emailSubject);
  console.log("\n" + (state.emailDraft ?? "(no draft)"));
} finally {
  // Playwright can leave the process alive on Windows even after close — force exit.
  await closeBrowser().catch(() => {});
  process.exit(0);
}
