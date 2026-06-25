// High-level backend service — the API the desktop app (and CLI) call.
// Reuses the scrapers + agents and reports progress through a callback so the UI can
// show live updates.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { searchPlaces } from "./scrapers/gmaps-search.js";
import { scrapePlace, scrapeGoogleReviews, type PlaceLead } from "./scrapers/gmaps-reviews.js";
import { crawlSite } from "./scrapers/crawler.js";
import { parseLeadCsv, type ManualLead } from "./lib/csv-leads.js";
import { researcherAgent } from "./agents/researcher.agent.js";
import { reviewsAnalystAgent } from "./agents/reviews-analyst.agent.js";
import { writerAgent } from "./agents/writer.agent.js";
import type { PipelineState } from "./pipeline/pipeline.js";
import { sender, offer } from "./config.js";

export type EmailStatus = "draft" | "approved" | "sent" | "failed";

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
}

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

  if (lead.website) {
    try {
      state.siteMarkdown = (await crawlSite(lead.website)).combinedMarkdown;
    } catch {
      /* crawl is best-effort */
    }
  }

  Object.assign(state, await researcherAgent(state));
  Object.assign(state, await reviewsAnalystAgent(state));
  Object.assign(state, await writerAgent(state));

  return {
    id: randomUUID(),
    name: lead.name,
    website: lead.website,
    address: lead.address,
    phone: lead.phone,
    email: extra.email ?? "",
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

// Generate emails for many leads, reporting progress per business.
export async function generateEmails(leads: PlaceLead[], onProgress?: ProgressFn): Promise<GeneratedEmail[]> {
  const out: GeneratedEmail[] = [];
  let i = 0;
  for (const lead of leads) {
    i++;
    const email = await generateEmail(lead);
    out.push(email);
    onProgress?.({
      phase: "email",
      message: `${lead.name}${email.error ? ` — failed: ${email.error}` : " — email ready"}`,
      current: i,
      total: leads.length,
    });
  }
  return out;
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

  const leads: PlaceLead[] = [];
  const emails: GeneratedEmail[] = [];
  let i = 0;
  for (const row of rows) {
    i++;
    onProgress?.({ phase: "place", message: `${row.name} — fetching reviews…`, current: i, total: rows.length });

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
    emails.push(email);
    onProgress?.({
      phase: "email",
      message: `${row.name}${email.error ? ` — failed: ${email.error}` : " — email ready"}`,
      current: i,
      total: rows.length,
    });
  }

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
