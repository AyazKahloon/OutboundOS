// Agent 2 — Writer: draft a personalized cold email from research.
// Calls Groq (Llama 3.3) with a strict prompt; returns emailSubject + emailDraft.
import type { PipelineState } from "../pipeline/pipeline.js";
import { groqChatJSON } from "../lib/groq.js";
import { offer, sender, models } from "../config.js";

const SYSTEM_PROMPT = `You write short, genuinely personal B2B cold emails. Never sound like a template.

STRUCTURE (the "body" field must follow this exactly):
- Line 1: a greeting using the recipient's FIRST NAME only, e.g. "Hi Kirsten,". If no
  recipient name is given, greet the business warmly instead, e.g. "Hi there," — never
  guess or invent a person's name.
- Sentence 1 — HOOK + PRAISE: open with a CREATIVE, specific compliment that genuinely praises
  their business. This is the hook — make it feel personally observed and a little fresh, like
  you actually paid attention. Ground it in a real positive review or true detail. VARY the
  phrasing every time; never open with "I noticed", "I came across", "I was impressed", "I saw",
  or "I hope this finds you well".
- Sentence 2 — PAIN: point to ONE concrete problem that shows up in their critical reviews,
  framed as something quietly costing them money and time (missed calls/leads, slow
  follow-up, scheduling or intake friction, after-hours gaps, long waits).
- Sentence 3 — PITCH (tailored): describe how you help in terms specific to THIS business and
  its industry — translate the offer into what it concretely means for them (e.g. a dentist →
  fewer missed appointment calls; a law firm → faster intake follow-up). Do NOT paste the offer
  verbatim. One low-key sentence: helping them save both time and money. No over-promising.
- Then exactly ONE low-friction question ending with "?".
- Then a blank line, then "Best," on its own line, then the sender's name on its own line.

RULES:
- 70-120 words total. Plain text only — no markdown, no bullet lists.
- Sound like a thoughtful human who genuinely looked at their business — NOT a salesperson.
  Absolutely no buzzwords or hype, no "I hope this finds you well", no "I wanted to reach out",
  no "game-changer", no "revolutionize". Plain, warm, specific.
- Always praise them — the opening compliment is mandatory, genuine, and specific to them.
- The compliment and the pain point MUST come from the provided reviews/research. Never
  invent specifics. If you have no real positive, keep the compliment light and true.
- Be tactful about the pain point — frame it as an opportunity, never insult their business.
- Make it clear in plain language that the gap is costing them BOTH time AND money, and that
  you can help them save both. Keep it low-key, not a hard pitch.
- The subject line must be specific and human, not salesy (no "Boost your revenue!!").
- Use real newlines between the greeting, the body, and the sign-off.
- The sender's name appears ONLY in the sign-off, never inside a sentence.

Respond with a JSON object: { "subject": string, "body": string }`;

function buildUserPrompt(state: PipelineState): string {
  const r = state.researchJson!;
  const rv = state.reviewsJson;
  const recipient = state.decisionMakerName
    ? `${state.decisionMakerName} at ${state.companyName}`
    : `the owner/manager at ${state.companyName}`;

  // Raw snippets give the writer concrete, authentic material to ground in.
  const snippet = (t: string) => `"${t.replace(/\s+/g, " ").slice(0, 200)}"`;
  const positives = (state.reviews ?? []).filter((rv) => (rv.rating ?? 0) >= 4 && rv.text).slice(0, 2).map((rv) => snippet(rv.text));
  const negatives = (state.reviews ?? []).filter((rv) => (rv.rating ?? 5) <= 2 && rv.text).slice(0, 3).map((rv) => snippet(rv.text));

  const reviewBlock = rv
    ? `
POSITIVE REVIEWS — compliment them on ONE of these (real praise):
- Themes: ${rv.commonPraise.join("; ") || "none"}
- Quotes: ${positives.join(" | ") || "none"}

CRITICAL REVIEWS — pitch against ONE of these pain points (costing them money + time):
- Complaints: ${rv.commonComplaints.join("; ") || "none"}
- Gaps AI/automation could fix: ${rv.serviceGaps.join("; ") || "none"}
- Quotes: ${negatives.join(" | ") || "none"}`
    : `
GOOGLE REVIEWS: (none available — compliment + pain point must come from the website research)`;

  return `SENDER: ${sender.name} from ${sender.company}
OFFER (the solution you pitch): ${offer}

RECIPIENT: ${recipient}

WEBSITE RESEARCH:
- What they do: ${r.whatTheyDo || "unknown"}
- Recent news: ${r.recentNews || "none"}
- Likely pain points: ${r.visiblePainPoints.join("; ") || "unknown"}
- Personalization hooks: ${r.personalizationHooks.join("; ") || "none"}
${reviewBlock}

Write the email: a creative, genuine compliment that praises them (the hook, from the
positives) → pain point (from the critical reviews, framed as lost revenue + wasted time) →
how you help, phrased specifically for a business like theirs → one soft question.
Sign off as ${sender.name}.`;
}

export async function writerAgent(state: PipelineState): Promise<Partial<PipelineState>> {
  try {
    if (!state.researchJson) return { error: "writer: no research available" };

    const raw = await groqChatJSON({
      model: models.writer,
      temperature: 0.75, // creative, varied hooks; retry in groqChatJSON covers rare JSON slips
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(state) },
      ],
    });
    const parsed = JSON.parse(raw) as { subject?: string; body?: string };

    if (!parsed.subject || !parsed.body) return { error: "writer: model returned empty subject/body" };
    return { emailSubject: parsed.subject, emailDraft: parsed.body };
  } catch (err) {
    return { error: `writer: ${(err as Error).message}` };
  }
}
