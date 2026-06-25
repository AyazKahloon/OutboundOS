// Agent 1 — Researcher: build a structured brief from the company's OWN website.
// Source is the in-house crawl (state.siteMarkdown) — no Firecrawl, no Tavily, no search API.
// Groq Llama 3.3 extracts a JSON summary grounded ONLY in the crawled pages.
import type { PipelineState } from "../pipeline/pipeline.js";
import { groqChatJSON } from "../lib/groq.js";
import { models } from "../config.js";

export type ResearchJson = NonNullable<PipelineState["researchJson"]>;

const SYSTEM_PROMPT = `You are a B2B sales researcher. From the provided website content, extract a
concise, factual brief about a company and (if named) a specific decision maker, to help
personalize a cold email.

Rules:
- Use ONLY facts supported by the website content. Do not invent or guess.
- If something is unknown, use an empty string "" or empty array [].
- Keep each field tight and specific (no marketing fluff).

Respond with a JSON object EXACTLY in this shape:
{
  "whatTheyDo": string,                 // 1-2 sentences on the company
  "recentNews": string,                 // any recent, datable event on the site; "" if none
  "decisionMakerInterests": string,     // what the person seems to care about; "" if unknown
  "visiblePainPoints": string[],        // concrete operational problems they likely have
  "personalizationHooks": string[]      // specific, true details usable as an email opener
}`;

export async function researcherAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  try {
    const site = (state.siteMarkdown ?? "").trim();

    // If the crawl produced nothing, don't hard-fail — return an empty (but non-null) brief
    // so the writer can still lean on review insight. Only mark error if we truly have nothing.
    if (!site) {
      const hasReviews = (state.reviews?.length ?? 0) > 0;
      if (!hasReviews) return { error: "researcher: no website content and no reviews to work from" };
      return {
        researchJson: {
          whatTheyDo: "",
          recentNews: "",
          decisionMakerInterests: "",
          visiblePainPoints: [],
          personalizationHooks: [],
        },
      };
    }

    const userPrompt = `Company: ${state.companyName}
Decision maker: ${state.decisionMakerName || "(unknown — personalize to the company)"}

WEBSITE CONTENT:
${site}`;

    const raw = await groqChatJSON({
      model: models.researcher,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });
    const parsed = JSON.parse(raw) as Partial<ResearchJson>;

    const researchJson: ResearchJson = {
      whatTheyDo: parsed.whatTheyDo ?? "",
      recentNews: parsed.recentNews ?? "",
      decisionMakerInterests: parsed.decisionMakerInterests ?? "",
      visiblePainPoints: Array.isArray(parsed.visiblePainPoints) ? parsed.visiblePainPoints : [],
      personalizationHooks: Array.isArray(parsed.personalizationHooks) ? parsed.personalizationHooks : [],
    };

    return { researchJson };
  } catch (err) {
    return { error: `researcher: ${(err as Error).message}` };
  }
}
