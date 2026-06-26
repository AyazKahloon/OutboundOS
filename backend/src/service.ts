// High-level backend service — the API the desktop app (and CLI) call.
// Reuses the scrapers + agents and reports progress through a callback so the UI can
// show live updates.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { searchPlaces } from "./scrapers/gmaps-search.js";
import { scrapePlace, scrapeGoogleReviews, type PlaceLead } from "./scrapers/gmaps-reviews.js";
import { crawlSite } from "./scrapers/crawler.js";
import { parseLeadCsv, type ManualLead } from "./lib/csv-leads.js";
import { composerAgent } from "./agents/composer.agent.js";
import type { PipelineState } from "./pipeline/pipeline.js";
import { sender, offer } from "./config.js";

// How many businesses to process in parallel (crawl + LLM overlap; Maps scraping stays
// serialized internally). Tune via OUTBOUNDOS_CONCURRENCY.
const CONCURRENCY = Math.max(1, Number(process.env.OUTBOUNDOS_CONCURRENCY) || 3);

// Run items through `fn` with a bounded number running at once.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type EmailStatus = "draft" | "approved" | "sent" | "failed" | "replied";

export interface GeneratedEmail {
  id: string;
  name: string;
  website: string;
  address: string;
  phone: string;
  email: string; // decision-maker email (from CSV), if any
  contactName: string;
  category: string;
  rating: number | null;
  totalReviews: number | null;
  reviewCount: number;
  negativeCount: number;
  subject: string;
  body: string;
  status: EmailStatus;
  sentAt?: string;
  error?: string;
  // ---- follow-up sequence state (set after the first email is sent) ----
  threadMessageId?: string; // Message-ID of the initial email (for threading + reply match)
  mailboxId?: string; // which mailbox sent it (follow-ups use the same one)
  sequenceStep?: number; // emails sent so far in the thread (1 = initial, 2 = first follow-up…)
  nextFollowupAt?: string | null; // ISO time the next follow-up is due (null = sequence finished/stopped)
  repliedAt?: string;
}

// Follow-up cadence: gaps (in days) AFTER each send. 3 follow-ups → 4 total touches.
export const FOLLOWUP_GAP_DAYS = [3, 4, 5];
export const MAX_SEQUENCE_STEPS = FOLLOWUP_GAP_DAYS.length + 1; // initial + follow-ups

export interface ProgressEvent {
  phase: "search" | "place" | "email" | "done" | "error";
  message: string;
  current?: number;
  total?: number;
}

export type ProgressFn = (e: ProgressEvent) => void;

const REVIEW_SAMPLE = { highest: 3, lowest: 5 };
const negative = (lead: PlaceLead) => lead.reviews.filter((r) => (r.rating ?? 5) <= 2).length;

// Search Maps and scrape each business + a balanced review sample.
export async function scrapeLeads(query: string, count: number, onProgress?: ProgressFn): Promise<PlaceLead[]> {
  onProgress?.({ phase: "search", message: `Searching Google Maps for "${query}"…` });
  const results = await searchPlaces(query, count);
  onProgress?.({ phase: "search", message: `Found ${results.length} businesses.`, total: results.length });

  const leads: PlaceLead[] = [];
  let i = 0;
  for (const r of results) {
    i++;
    const lead = await scrapePlace({ placeUrl: r.placeUrl, name: r.name }, REVIEW_SAMPLE);
    lead.rating ??= r.rating;
    lead.totalReviews ??= r.reviewCount;
    leads.push(lead);
    onProgress?.({
      phase: "place",
      message: `${lead.name} — ${lead.reviews.length} reviews (${negative(lead)} negative)${lead.website ? "" : " · no website"}`,
      current: i,
      total: results.length,
    });
  }
  return leads;
}

// Crawl one business's site, analyze its reviews, and write a personalized email.
// `extra` carries CSV-supplied fields (decision-maker email / name) through to the output.
export async function generateEmail(
  lead: PlaceLead,
  extra: { email?: string; contactName?: string } = {}
): Promise<GeneratedEmail> {
  const state: PipelineState = {
    leadId: "app",
    companyName: lead.name,
    companyWebsite: lead.website,
    address: lead.address,
    category: lead.category,
    decisionMakerName: extra.contactName ?? "",
    siteMarkdown: "",
    reviews: lead.reviews,
    reviewsMeta: { averageRating: lead.rating, totalReviews: lead.totalReviews },
    researchJson: null,
    reviewsJson: null,
    emailSubject: null,
    emailDraft: null,
    error: null,
  };

  // Crawl the site; also harvest a contact email from it (search mode has none from Maps).
  let crawledEmail = "";
  if (lead.website) {
    try {
      const crawl = await crawlSite(lead.website);
      state.siteMarkdown = crawl.combinedMarkdown;
      state.siteSignals = crawl.siteSignals;
      crawledEmail = crawl.email;
    } catch {
      /* crawl is best-effort */
    }
  }

  // One Groq call writes the whole email (was 3 calls: research + analyze + write).
  Object.assign(state, await composerAgent(state));

  return {
    id: randomUUID(),
    name: lead.name,
    website: lead.website,
    address: lead.address,
    phone: lead.phone,
    // CSV-provided email wins; otherwise use the one harvested from the website.
    email: extra.email || crawledEmail || "",
    contactName: extra.contactName ?? "",
    category: lead.category,
    rating: lead.rating,
    totalReviews: lead.totalReviews,
    reviewCount: lead.reviews.length,
    negativeCount: negative(lead),
    subject: state.emailSubject ?? "",
    body: state.emailDraft ?? "",
    status: state.error ? "failed" : "draft",
    error: state.error ?? undefined,
  };
}

// Generate emails for many leads — processed in parallel (crawl + LLM overlap).
export async function generateEmails(leads: PlaceLead[], onProgress?: ProgressFn): Promise<GeneratedEmail[]> {
  let done = 0;
  return mapPool(leads, CONCURRENCY, async (lead) => {
    const email = await generateEmail(lead);
    done++;
    onProgress?.({
      phase: "email",
      message: `${lead.name}${email.error ? ` — failed: ${email.error}` : " — email ready"}`,
      current: done,
      total: leads.length,
    });
    return email;
  });
}

// Convenience: scrape then generate in one call.
export async function scrapeAndGenerate(
  query: string,
  count: number,
  onProgress?: ProgressFn
): Promise<{ leads: PlaceLead[]; emails: GeneratedEmail[] }> {
  if (offer.startsWith("TODO") || sender.name.startsWith("TODO")) {
    throw new Error("Set your name, company and offer in Settings before generating emails.");
  }
  const leads = await scrapeLeads(query, count, onProgress);
  const emails = await generateEmails(leads, onProgress);
  onProgress?.({ phase: "done", message: `Done — ${emails.filter((e) => !e.error).length}/${emails.length} emails ready.` });
  return { leads, emails };
}

// CSV path: each row already has the website + decision-maker email. Per row we scrape its
// Google reviews, crawl the site, and write the email. (No Maps search needed.)
export async function processManualLeads(
  rows: ManualLead[],
  onProgress?: ProgressFn
): Promise<{ leads: PlaceLead[]; emails: GeneratedEmail[] }> {
  if (offer.startsWith("TODO") || sender.name.startsWith("TODO")) {
    throw new Error("Set your name, company and offer in Settings before generating emails.");
  }

  // Processed in parallel. The Maps review scrape inside is serialized by its own lock, so
  // while one business's reviews are being fetched, others crawl + call the LLM.
  let done = 0;
  const leads: PlaceLead[] = [];
  const emails = await mapPool(rows, CONCURRENCY, async (row) => {
    // Reviews come from Maps (by name + address); details (website) come from the CSV.
    let reviews: PlaceLead["reviews"] = [];
    let rating: number | null = null;
    let totalReviews: number | null = null;
    try {
      const rev = await scrapeGoogleReviews({ name: row.name, address: row.address });
      reviews = rev.reviews;
      rating = rev.averageRating;
      totalReviews = rev.totalReviews;
    } catch {
      /* reviews best-effort */
    }

    const lead: PlaceLead = {
      name: row.name,
      placeUrl: "",
      website: row.website,
      phone: "",
      address: row.address,
      category: "",
      rating,
      totalReviews,
      reviews,
    };
    leads.push(lead);

    const email = await generateEmail(lead, { email: row.email, contactName: row.contactName });
    done++;
    onProgress?.({
      phase: "email",
      message: `${row.name}${email.error ? ` — failed: ${email.error}` : " — email ready"}`,
      current: done,
      total: rows.length,
    });
    return email;
  });

  onProgress?.({ phase: "done", message: `Done — ${emails.filter((e) => !e.error).length}/${emails.length} emails ready.` });
  return { leads, emails };
}

// Read a CSV file from disk and run the manual-lead pipeline.
export async function processCsvFile(
  filePath: string,
  onProgress?: ProgressFn
): Promise<{ leads: PlaceLead[]; emails: GeneratedEmail[]; query: string }> {
  const { leads: rows, columns } = parseLeadCsv(readFileSync(filePath, "utf8"));
  onProgress?.({
    phase: "search",
    message: `Loaded ${rows.length} rows (columns → name:"${columns.name}" website:"${columns.website ?? "—"}" email:"${columns.email ?? "—"}").`,
    total: rows.length,
  });
  const { leads, emails } = await processManualLeads(rows, onProgress);
  return { leads, emails, query: `CSV: ${rows.length} leads` };
}
