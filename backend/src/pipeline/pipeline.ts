// LangGraph state machine: researcher -> writer -> save.
// (Scraper runs upstream to create leads; scheduler runs downstream after human approval.)
import { StateGraph, Annotation } from "@langchain/langgraph";
import { researcherAgent } from "../agents/researcher.agent.js";
import { reviewsAnalystAgent } from "../agents/reviews-analyst.agent.js";
import { writerAgent } from "../agents/writer.agent.js";
import type { GoogleReview } from "../scrapers/gmaps-reviews.js";
import { prisma } from "../db/client.js";

// State that flows between agents.
export interface PipelineState {
  leadId: string;
  companyName: string;
  companyWebsite: string;
  address: string;
  decisionMakerName: string;

  // Populated by the in-house crawler (replaces Firecrawl)
  siteMarkdown: string;

  // Populated by the in-house Google Maps reviews scraper
  reviews: GoogleReview[];
  reviewsMeta: { averageRating: number | null; totalReviews: number | null } | null;

  // Populated by researcher (synthesizes the crawled site)
  researchJson: {
    whatTheyDo: string;
    recentNews: string;
    decisionMakerInterests: string;
    visiblePainPoints: string[];
    personalizationHooks: string[];
  } | null;

  // Populated by reviews-analyst
  reviewsJson: {
    overallSentiment: string;
    commonPraise: string[];
    commonComplaints: string[];
    serviceGaps: string[];
    reviewHooks: string[];
  } | null;

  // Populated by writer
  emailSubject: string | null;
  emailDraft: string | null;

  error: string | null;
}

// LangGraph channel definition mirroring PipelineState.
const StateAnnotation = Annotation.Root({
  leadId: Annotation<string>(),
  companyName: Annotation<string>(),
  companyWebsite: Annotation<string>(),
  address: Annotation<string>(),
  decisionMakerName: Annotation<string>(),
  siteMarkdown: Annotation<string>(),
  reviews: Annotation<PipelineState["reviews"]>(),
  reviewsMeta: Annotation<PipelineState["reviewsMeta"]>(),
  researchJson: Annotation<PipelineState["researchJson"]>(),
  reviewsJson: Annotation<PipelineState["reviewsJson"]>(),
  emailSubject: Annotation<string | null>(),
  emailDraft: Annotation<string | null>(),
  error: Annotation<string | null>(),
});

// Node: crawl the company website ourselves (no Firecrawl). Best-effort.
async function crawlNode(state: PipelineState): Promise<Partial<PipelineState>> {
  if (!state.companyWebsite) return { siteMarkdown: "" };
  try {
    const { crawlSite } = await import("../scrapers/crawler.js");
    const res = await crawlSite(state.companyWebsite);
    return { siteMarkdown: res.combinedMarkdown };
  } catch (err) {
    console.warn(`[pipeline] crawl failed for ${state.companyWebsite}: ${(err as Error).message}`);
    return { siteMarkdown: "" };
  }
}

// Node: scrape Google reviews ourselves (no API). Best-effort.
async function reviewsNode(state: PipelineState): Promise<Partial<PipelineState>> {
  try {
    const { scrapeGoogleReviews } = await import("../scrapers/gmaps-reviews.js");
    const res = await scrapeGoogleReviews({ name: state.companyName, address: state.address });
    if (res.blocked) console.warn(`[pipeline] reviews blocked for ${state.companyName}: ${res.note}`);
    return { reviews: res.reviews, reviewsMeta: { averageRating: res.averageRating, totalReviews: res.totalReviews } };
  } catch (err) {
    console.warn(`[pipeline] reviews failed for ${state.companyName}: ${(err as Error).message}`);
    return { reviews: [], reviewsMeta: null };
  }
}

async function saveToDb(state: PipelineState): Promise<Partial<PipelineState>> {
  const ready = Boolean(state.emailDraft && state.emailSubject);
  if (!ready && state.error) console.warn(`[pipeline] lead ${state.leadId} failed: ${state.error}`);

  await prisma.lead.update({
    where: { id: state.leadId },
    data: {
      researchJson: state.researchJson ?? undefined,
      emailSubject: state.emailSubject,
      emailDraft: state.emailDraft,
      status: ready ? "draft_ready" : "failed",
    },
  });
  return {};
}

// crawl + reviews run first (data gathering), then the two analysts, then the writer.
const graph = new StateGraph(StateAnnotation)
  .addNode("crawl", crawlNode)
  .addNode("reviews", reviewsNode)
  .addNode("researcher", researcherAgent)
  .addNode("reviewsAnalyst", reviewsAnalystAgent)
  .addNode("writer", writerAgent)
  .addNode("save", saveToDb)
  .addEdge("__start__", "crawl")
  .addEdge("crawl", "reviews")
  .addEdge("reviews", "researcher")
  .addEdge("researcher", "reviewsAnalyst")
  .addEdge("reviewsAnalyst", "writer")
  .addEdge("writer", "save")
  .addEdge("save", "__end__");

export const pipeline = graph.compile();
