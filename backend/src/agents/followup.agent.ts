// Agent — Follow-up writer: writes a short follow-up sent as a reply in the same thread.
// One Groq call per follow-up, only generated when a follow-up actually becomes due.
import { groqChatJSON } from "../lib/groq.js";
import { humanize } from "../lib/text.js";
import { sender, models } from "../config.js";

// What each follow-up step should do. Step 1 is the original email (not generated here).
const ANGLES: Record<number, string> = {
  2: "A short, friendly bump. Reference the first email lightly without repeating it, add ONE concrete benefit or quick example relevant to them, and ask if they want to hear more.",
  3: "A different angle. Briefly mention how it works or a quick result similar businesses see, keep it casual, and ask one low friction question.",
  4: "A short, polite breakup. Say you do not want to keep cluttering their inbox and ask if you should close this out or if it is worth a quick look. Two sentences.",
};

export interface FollowupInput {
  name: string;
  contactName?: string;
  originalSubject: string;
  originalBody: string;
  step: number; // which follow-up (2, 3, 4)
}

export async function generateFollowup(input: FollowupInput): Promise<{ subject: string; body: string } | { error: string }> {
  const angle = ANGLES[input.step] ?? ANGLES[2]!;
  const system = `You write very short cold-email FOLLOW-UPS for ${sender.company}, sent as a reply in
the same email thread. Sound like a real person quickly following up, never like AI and never pushy.

RULES:
- 2 to 4 sentences, under 70 words. Plain text only.
- Do NOT repeat the original email. This is a follow-up in the same thread.
- NEVER use dashes of any kind. Use commas and periods. No buzzwords, no hype.
- Greet with the recipient's first name if one is given, otherwise "Hi there,".
- Exactly one soft question. End with "Best," on its own line, then "${sender.name}".

This follow-up's job: ${angle}

Respond with a JSON object: { "subject": string, "body": string }`;

  const user = `BUSINESS: ${input.name}
RECIPIENT FIRST NAME: ${input.contactName ? input.contactName.split(" ")[0] : "(none, use 'Hi there,')"}

YOUR ORIGINAL EMAIL (context only, do not repeat it):
Subject: ${input.originalSubject}
${input.originalBody}

Write follow-up number ${input.step}.`;

  try {
    const raw = await groqChatJSON({
      model: models.writer,
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const parsed = JSON.parse(raw) as { body?: string };
    if (!parsed.body) return { error: "followup: model returned empty body" };
    // Keep it threaded: subject is always "Re: <original>".
    const subject = `Re: ${input.originalSubject.replace(/^\s*re:\s*/i, "")}`;
    return { subject, body: humanize(parsed.body) };
  } catch (err) {
    return { error: `followup: ${(err as Error).message}` };
  }
}
