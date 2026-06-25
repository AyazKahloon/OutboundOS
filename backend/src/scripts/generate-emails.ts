// Batch-generate finished cold emails from a Google-Maps business CSV and write them to a file.
// Fully in-house: we crawl each site and scrape its Google reviews with our own headless
// browser. The ONLY paid dependency is Groq (the LLM). Does NOT touch the DB, does NOT send.
//
// Usage (from repo root):
//   pnpm --filter @outboundos/backend generate-emails [leads.json | maps.csv] [count] [outBaseName] [concurrency]
// A leads.json (from scrape-leads) carries reviews already, so we skip the live scrape.
// Defaults: ./leads.json, 25 leads, ./generated_emails.{md,csv}, concurrency 2
import "../lib/env.js"; // must be first — loads root .env before ../config reads it
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import Papa from "papaparse";
import { DATA_DIR } from "../lib/paths.js";
import { crawlSite } from "../scrapers/crawler.js";
import { scrapeGoogleReviews, type GoogleReview, type PlaceLead } from "../scrapers/gmaps-reviews.js";
import { researcherAgent } from "../agents/researcher.agent.js";
import { reviewsAnalystAgent } from "../agents/reviews-analyst.agent.js";
import { writerAgent } from "../agents/writer.agent.js";
import type { PipelineState } from "../pipeline/pipeline.js";
import { closeBrowser } from "../lib/browser.js";
import { sender, offer } from "../config.js";

const REPO_ROOT = DATA_DIR;

const clean = (v: string | undefined) => v?.trim() || "";
const toWebsite = (d: string) => (!d ? "" : /^https?:\/\//i.test(d) ? d : `https://${d}`);

// Google-Maps exports vary in header naming — match columns by keyword, case-insensitive.
function findCol(headers: string[], candidates: string[]): string | null {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const cand of candidates) {
    const i = lower.findIndex((h) => h === cand || h.includes(cand));
    if (i !== -1) return headers[i]!;
  }
  return null;
}

interface Lead {
  companyName: string;
  address: string;
  companyWebsite: string;
  contactName: string;
  email: string;
  // Present when leads come from a scraped leads.json — reviews already attached, so we
  // skip the live Maps scrape and go straight to crawl + analysis + writing.
  reviews?: GoogleReview[];
  rating?: number | null;
  totalReviews?: number | null;
}

interface Generated extends Lead {
  subject: string;
  body: string;
  reviewSummary: string;
  reviewCount: number;
  error?: string;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur]!, cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function generate(lead: Lead): Promise<Generated> {
  const state: PipelineState = {
    leadId: "batch",
    companyName: lead.companyName,
    companyWebsite: lead.companyWebsite,
    address: lead.address,
    decisionMakerName: lead.contactName,
    siteMarkdown: "",
    reviews: [],
    reviewsMeta: null,
    researchJson: null,
    reviewsJson: null,
    emailSubject: null,
    emailDraft: null,
    error: null,
  };

  // 1) In-house crawl (best-effort).
  if (state.companyWebsite) {
    try {
      const crawl = await crawlSite(state.companyWebsite);
      state.siteMarkdown = crawl.combinedMarkdown;
    } catch (err) {
      console.warn(`  · crawl failed (${lead.companyName}): ${(err as Error).message}`);
    }
  }

  // 2) Reviews: reuse pre-scraped ones from leads.json, otherwise scrape live (best-effort).
  if (lead.reviews) {
    state.reviews = lead.reviews;
    state.reviewsMeta = { averageRating: lead.rating ?? null, totalReviews: lead.totalReviews ?? null };
  } else {
    try {
      const rev = await scrapeGoogleReviews({ name: lead.companyName, address: lead.address });
      state.reviews = rev.reviews;
      state.reviewsMeta = { averageRating: rev.averageRating, totalReviews: rev.totalReviews };
      if (rev.blocked) console.warn(`  · reviews blocked (${lead.companyName}): ${rev.note}`);
    } catch (err) {
      console.warn(`  · reviews failed (${lead.companyName}): ${(err as Error).message}`);
    }
  }

  // 3) Analysts → writer.
  Object.assign(state, await researcherAgent(state));
  Object.assign(state, await reviewsAnalystAgent(state));
  Object.assign(state, await writerAgent(state));

  const rating = state.reviewsMeta?.averageRating;
  const total = state.reviewsMeta?.totalReviews;
  return {
    ...lead,
    subject: state.emailSubject ?? "",
    body: state.emailDraft ?? "",
    reviewSummary: state.reviews.length ? `${rating ?? "?"}★ from ${total ?? state.reviews.length} reviews` : "no reviews",
    reviewCount: state.reviews.length,
    error: state.error ?? undefined,
  };
}

// Leads from a scraped leads.json (PlaceLead[] with reviews already attached).
function loadLeadsFromJson(path: string): Lead[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { leads?: PlaceLead[] } | PlaceLead[];
  const places = Array.isArray(raw) ? raw : raw.leads ?? [];
  return places
    .map((p) => ({
      companyName: clean(p.name),
      address: clean(p.address),
      companyWebsite: toWebsite(clean(p.website)),
      contactName: "",
      email: "",
      reviews: p.reviews ?? [],
      rating: p.rating ?? null,
      totalReviews: p.totalReviews ?? null,
    }))
    .filter((l) => l.companyName);
}

// Leads from a Maps CSV export (columns matched by keyword). Reviews scraped live later.
function loadLeadsFromCsv(path: string): Lead[] {
  const parsed = Papa.parse<Record<string, string>>(readFileSync(path, "utf8"), { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? [];
  const nameCol = findCol(headers, ["name", "business", "company", "title"]);
  const addrCol = findCol(headers, ["full_address", "address", "location", "street"]);
  const siteCol = findCol(headers, ["website", "site", "url", "domain", "web"]);
  const contactCol = findCol(headers, ["owner", "contact", "person", "manager"]);
  const emailCol = findCol(headers, ["email", "e-mail", "mail"]);
  if (!nameCol) {
    throw new Error(`Could not find a business-name column. Headers seen: ${headers.join(", ") || "(none)"}`);
  }
  console.log(`Columns → name:"${nameCol}" address:"${addrCol ?? "—"}" website:"${siteCol ?? "—"}" contact:"${contactCol ?? "—"}" email:"${emailCol ?? "—"}"`);
  return parsed.data
    .map((row) => ({
      companyName: clean(nameCol ? row[nameCol] : ""),
      address: clean(addrCol ? row[addrCol] : ""),
      companyWebsite: toWebsite(clean(siteCol ? row[siteCol] : "")),
      contactName: clean(contactCol ? row[contactCol] : ""),
      email: clean(emailCol ? row[emailCol] : ""),
    }))
    .filter((l) => l.companyName);
}

async function main() {
  if (offer.startsWith("TODO") || sender.name.startsWith("TODO")) {
    throw new Error("Set OFFER, SENDER_NAME and SENDER_COMPANY in .env before generating emails.");
  }

  const inputArg = process.argv[2];
  // Resolve against the cwd first, then fall back to the repo root (pnpm --filter runs
  // with cwd at the package dir, but outputs live at the repo root).
  let inputPath = inputArg ? resolve(process.cwd(), inputArg) : join(REPO_ROOT, "leads.json");
  if (inputArg && !existsSync(inputPath) && existsSync(join(REPO_ROOT, inputArg))) {
    inputPath = join(REPO_ROOT, inputArg);
  }
  if (!existsSync(inputPath)) {
    throw new Error(
      `Input not found: ${inputPath}\n` +
        `Pass a leads.json (from scrape-leads) or a Maps CSV:\n` +
        `  pnpm --filter @outboundos/backend generate-emails "<leads.json | maps-export.csv>"`
    );
  }
  const count = Number(process.argv[3] ?? 25);
  const outBase = process.argv[4] ?? "generated_emails";
  const concurrency = Number(process.argv[5] ?? 2);

  const isJson = inputPath.toLowerCase().endsWith(".json");
  const leads = (isJson ? loadLeadsFromJson(inputPath) : loadLeadsFromCsv(inputPath)).slice(0, count);
  console.log(
    isJson
      ? `Loaded ${leads.length} leads (reviews pre-scraped) from ${inputPath}\n`
      : `Generating ${leads.length} emails from ${inputPath} (concurrency ${concurrency}) …\n`
  );

  let done = 0;
  const results = await mapPool(leads, concurrency, async (lead) => {
    const g = await generate(lead);
    done++;
    console.log(
      `  [${done}/${leads.length}] ${g.error ? "✗" : "✓"} ${lead.companyName} ` +
        `— ${g.reviewCount} reviews${g.error ? ` (${g.error})` : ""}`
    );
    return g;
  });

  await closeBrowser();

  // Markdown (human review)
  const md = [
    `# Generated outbound emails (${results.length})`,
    ``,
    `Source: \`${inputPath}\``,
    `Sender: ${sender.name}, ${sender.company}`,
    `Pipeline: in-house crawl + Google reviews → research → review-analysis → writer (Groq only)`,
    ``,
    `---`,
    ``,
    ...results.map((r, i) =>
      r.error
        ? `## ${i + 1}. ${r.companyName}\n**To:** ${r.email || "—"}\n**Reviews:** ${r.reviewSummary}\n\n> ⚠️ generation failed: ${r.error}\n`
        : `## ${i + 1}. ${r.companyName}\n**To:** ${r.email || "—"}${r.contactName ? ` · ${r.contactName}` : ""}\n**Reviews:** ${r.reviewSummary}\n**Subject:** ${r.subject}\n\n${r.body}\n`
    ),
  ].join("\n");

  // CSV (mail-merge friendly)
  const csv = Papa.unparse(
    results.map((r) => ({
      companyName: r.companyName,
      contactName: r.contactName,
      email: r.email,
      address: r.address,
      website: r.companyWebsite,
      reviews: r.reviewSummary,
      subject: r.subject,
      body: r.body,
      error: r.error ?? "",
    }))
  );

  const mdPath = join(REPO_ROOT, `${outBase}.md`);
  const csvPathOut = join(REPO_ROOT, `${outBase}.csv`);
  writeFileSync(mdPath, md, "utf8");
  writeFileSync(csvPathOut, csv, "utf8");

  const failed = results.filter((r) => r.error).length;
  console.log(`\nDone. ${results.length - failed} ok, ${failed} failed.`);
  console.log(`  ${mdPath}`);
  console.log(`  ${csvPathOut}`);
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
