// In-house Google Maps lead scraper. Search a query, scrape each business + a balanced
// review sample (most-relevant + lowest-rated for pain points), and write a JSON the AI
// can consume directly. No API, no cost (real Chrome drives Maps locally).
//
// Usage (from repo root):
//   pnpm --filter @outboundos/backend scrape-leads "law firms in Austin TX" [count] [outBaseName]
// Defaults: 20 businesses, ./leads.{json,csv}
import "../lib/env.js"; // must be first
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { searchPlaces } from "../scrapers/gmaps-search.js";
import { scrapePlace, type PlaceLead } from "../scrapers/gmaps-reviews.js";
import { closeBrowser } from "../lib/browser.js";
import { DATA_DIR } from "../lib/paths.js";

const REPO_ROOT = DATA_DIR;

// How many reviews to sample per business.
const REVIEW_SAMPLE = { highest: 3, lowest: 5 };

async function main() {
  const query = process.argv[2];
  if (!query) {
    throw new Error('Provide a search query, e.g.  pnpm --filter @outboundos/backend scrape-leads "law firms in Austin TX"');
  }
  const count = Number(process.argv[3] ?? 20);
  const outBase = process.argv[4] ?? "leads";

  console.log(`Searching Google Maps for "${query}" …`);
  const results = await searchPlaces(query, count);
  console.log(`Found ${results.length} businesses. Scraping details + reviews (this opens a real Chrome window) …\n`);

  const leads: PlaceLead[] = [];
  let i = 0;
  for (const r of results) {
    i++;
    const lead = await scrapePlace({ placeUrl: r.placeUrl, name: r.name }, REVIEW_SAMPLE);
    // Backfill rating/count from the search card if the place header didn't expose them.
    lead.rating ??= r.rating;
    lead.totalReviews ??= r.reviewCount;
    leads.push(lead);
    const neg = lead.reviews.filter((rv) => (rv.rating ?? 5) <= 2).length;
    console.log(
      `  [${i}/${results.length}] ${lead.name} — ${lead.reviews.length} reviews (${neg} negative)` +
        `${lead.website ? "" : " · no website"}${lead.note ? ` · ${lead.note}` : ""}`
    );
  }

  await closeBrowser();

  // JSON — the artifact we feed to the AI.
  const jsonPath = join(REPO_ROOT, `${outBase}.json`);
  writeFileSync(jsonPath, JSON.stringify({ query, scrapedCount: leads.length, leads }, null, 2), "utf8");

  // CSV — a flat overview for eyeballing.
  const csvPath = join(REPO_ROOT, `${outBase}.csv`);
  const csv = Papa.unparse(
    leads.map((l) => ({
      name: l.name,
      website: l.website,
      phone: l.phone,
      address: l.address,
      category: l.category,
      rating: l.rating ?? "",
      totalReviews: l.totalReviews ?? "",
      sampledReviews: l.reviews.length,
      negativeReviews: l.reviews.filter((rv) => (rv.rating ?? 5) <= 2).length,
      placeUrl: l.placeUrl,
    }))
  );
  writeFileSync(csvPath, csv, "utf8");

  const withReviews = leads.filter((l) => l.reviews.length).length;
  const withSite = leads.filter((l) => l.website).length;
  console.log(`\nDone. ${leads.length} businesses — ${withReviews} with reviews, ${withSite} with a website.`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${csvPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Playwright can leave the process alive on Windows even after close — force exit.
    await closeBrowser().catch(() => {});
    process.exit(process.exitCode ?? 0);
  });
