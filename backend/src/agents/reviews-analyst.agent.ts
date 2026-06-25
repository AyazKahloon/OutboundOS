// Agent — Reviews Analyst: turn raw Google reviews into email-ready insight.
// The complaints/service-gaps are the strongest hooks for the "streamline with AI /
// stop leaking revenue" angle (missed calls, slow callbacks, scheduling friction...).
import type { PipelineState } from "../pipeline/pipeline.js";
import { groqChatJSON } from "../lib/groq.js";
import { models } from "../config.js";

export type ReviewsJson = NonNullable<PipelineState["reviewsJson"]>;

const SYSTEM_PROMPT = `You analyze a business's Google reviews to help personalize a cold email.
From ONLY the reviews provided, extract honest patterns. Do not invent praise or complaints.

Two jobs:
1) Find genuine, SPECIFIC things to compliment them on (what customers consistently love) —
   this is used to flatter the owner sincerely, so keep it concrete, not generic.
2) Find operational pain that is quietly costing them REVENUE and TIME, and that software/AI
   could fix: missed or unanswered calls/leads, slow responses/follow-up, scheduling or intake
   friction, after-hours gaps, long wait times, no-shows, billing confusion.

Respond with a JSON object EXACTLY in this shape:
{
  "overallSentiment": string,        // 1 sentence: how customers generally feel
  "commonPraise": string[],          // specific, genuine positives to compliment them on
  "commonComplaints": string[],      // recurring negatives
  "serviceGaps": string[],           // gaps AI/automation could close, framed as lost revenue/time
  "reviewHooks": string[]            // specific, true details usable to open an email
}`;

function buildUserPrompt(state: PipelineState): string {
  const r = state.reviews ?? [];
  const lines = r
    .map(
      (rv, i) =>
        `${i + 1}. [${rv.rating ?? "?"}★, ${rv.relativeTime || "n/a"}] ${rv.author || "Anonymous"}: ${rv.text || "(no text)"}`
    )
    .join("\n");
  return `Business: ${state.companyName}
Average rating: ${state.reviewsMeta?.averageRating ?? "unknown"} (${state.reviewsMeta?.totalReviews ?? "unknown"} reviews)

REVIEWS:
${lines || "(no reviews available)"}`;
}

export async function reviewsAnalystAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  // No reviews → don't fail the pipeline; just leave reviewsJson null and let the
  // writer personalize from the website crawl alone.
  if (!state.reviews || state.reviews.length === 0) {
    return { reviewsJson: null };
  }

  try {
    const raw = await groqChatJSON({
      model: models.reviewsAnalyst,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(state) },
      ],
    });
    const parsed = JSON.parse(raw) as Partial<ReviewsJson>;

    return {
      reviewsJson: {
        overallSentiment: parsed.overallSentiment ?? "",
        commonPraise: Array.isArray(parsed.commonPraise) ? parsed.commonPraise : [],
        commonComplaints: Array.isArray(parsed.commonComplaints) ? parsed.commonComplaints : [],
        serviceGaps: Array.isArray(parsed.serviceGaps) ? parsed.serviceGaps : [],
        reviewHooks: Array.isArray(parsed.reviewHooks) ? parsed.reviewHooks : [],
      },
    };
  } catch (err) {
    // Analysis failure shouldn't block the email — degrade to no review insight.
    console.warn(`[reviews-analyst] ${(err as Error).message}`);
    return { reviewsJson: null };
  }
}
