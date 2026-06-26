// Agent — Composer: writes the whole email in ONE Groq call.
// Replaces the old researcher → reviews-analyst → writer chain (3 calls) with a single call
// that reads the website text + the best/worst reviews and writes the email directly.
// Same output ({ emailSubject, emailDraft }), 1/3 the API calls, fewer tokens.
import type { PipelineState } from "../pipeline/pipeline.js";
import { groqChatJSON } from "../lib/groq.js";
import { humanize } from "../lib/text.js";
import { offer, sender, models } from "../config.js";

const SYSTEM_PROMPT = `You write short, genuinely personal B2B cold emails for KodWorks, a custom
software and automation agency. KodWorks builds bespoke software (web apps, mobile apps,
internal tools) and automation that removes manual, repetitive work: AI chatbots, WhatsApp bots,
voice agents that answer and make calls for support, lead capture and follow up and push leads
into a CRM, document, workflow and data entry automation, and help getting more Google reviews.

Your job: from the business's website signals, its reviews and its industry, find ONE real,
concrete opportunity and pitch the single KodWorks solution that fits it best. Sound like a
thoughtful human who actually looked at their business, never like AI or a salesperson.

FINDING THE OPPORTUNITY (use the strongest available, roughly in this order):
1. A gap on their website, from SITE SIGNALS. For example no online booking, no live chat or
   chatbot, no WhatsApp, only a basic contact form, or no mobile app. Do NOT pitch something the
   signals say they already have.
2. Operational pain in their reviews: missed or after hours calls, slow follow up, scheduling
   friction, long waits, no shows.
3. Their industry's typical manual burden. Infer the industry from the name, category and
   website. For example a law firm handles heavy documents, contracts and client intake, so
   pitch document and intake automation. A clinic or dentist struggles with scheduling,
   reminders and missed calls. Real estate needs fast lead capture and follow up. A restaurant
   or shop needs bookings, ordering or more reviews.
4. Few or low Google reviews means you can pitch help getting more reviews.

Pick the ONE KodWorks solution that fits best and describe it specifically for their business.

STRUCTURE (the "body" field must follow this exactly):
- Line 1: a greeting using the recipient's first name only ("Hi Sara,"). If no name is given,
  greet warmly ("Hi there,"). Never invent a name.
- Sentence 1: a specific, genuine compliment grounded in a real review or a true website detail.
- Sentence 2: the one concrete gap or opportunity you found, framed tactfully as something that
  is quietly costing them time, money or leads. Never insult them. Never state something as a
  fact unless the signals, reviews or website support it.
- Sentence 3: the matching KodWorks solution, phrased for their specific business and industry,
  and how it saves them time and money.
- Then exactly ONE low friction question ending with "?".
- Then a blank line, then "Best," on its own line, then the sender's name on its own line.

RULES:
- 70 to 120 words. Plain text only. No markdown, no bullets, no buzzwords, no hype.
- NEVER use dashes of any kind (em dash, en dash, or a hyphen used as a pause). Use commas and
  periods instead. Dashes make it look AI written.
- Write the way a real person types a quick email in Gmail. Natural and a little casual, not
  polished or perfect. Avoid AI tell words like delve, leverage, seamless, elevate, robust,
  unlock, tapestry.
- Ground everything in the provided material. If signals and reviews are thin, lean on the
  industry and the website content, and stay honest.
- The sender's name appears ONLY in the sign off. The subject is specific, human, no dashes.

Respond with a JSON object: { "subject": string, "body": string }`;

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const snippet = (t: string) => `"${t.replace(/\s+/g, " ").slice(0, 200)}"`;

function buildUserPrompt(state: PipelineState): string {
  const recipient = state.decisionMakerName
    ? `${state.decisionMakerName} at ${state.companyName}`
    : `the owner/manager at ${state.companyName}`;

  const reviews = state.reviews ?? [];
  const positives = reviews.filter((r) => (r.rating ?? 0) >= 4 && r.text).slice(0, 3).map((r) => snippet(r.text));
  const negatives = reviews.filter((r) => (r.rating ?? 5) <= 2 && r.text).slice(0, 4).map((r) => snippet(r.text));
  const site = (state.siteMarkdown ?? "").trim();

  const industry = state.category && state.category.trim() ? state.category : "(infer from the name and website)";

  return `SENDER: ${sender.name} from ${sender.company}
KODWORKS SERVICES (pick the single best fit for this business): ${offer}
RECIPIENT: ${recipient}
BUSINESS: ${state.companyName}
INDUSTRY / CATEGORY: ${industry}
GOOGLE RATING: ${state.reviewsMeta?.averageRating ?? "unknown"} from ${state.reviewsMeta?.totalReviews ?? "unknown"} reviews

WHAT WE FOUND ON THEIR WEBSITE (spot a real gap here, and do not pitch what they already have):
${state.siteSignals || "(nothing detected)"}

WEBSITE CONTENT:
${site ? truncate(site, 3500) : "(no website content)"}

POSITIVE REVIEWS (compliment them on one of these):
${positives.join("\n") || "(none)"}

CRITICAL REVIEWS (a source of pain you can address):
${negatives.join("\n") || "(none)"}`;
}

export async function composerAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  try {
    if (!state.siteMarkdown?.trim() && (state.reviews?.length ?? 0) === 0) {
      return { error: "composer: no website content and no reviews to work from" };
    }
    const raw = await groqChatJSON({
      model: models.writer,
      temperature: 0.75,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(state) },
      ],
    });
    const parsed = JSON.parse(raw) as { subject?: string; body?: string };
    if (!parsed.subject || !parsed.body) return { error: "composer: model returned empty subject/body" };
    return { emailSubject: humanize(parsed.subject), emailDraft: humanize(parsed.body) };
  } catch (err) {
    return { error: `composer: ${(err as Error).message}` };
  }
}
