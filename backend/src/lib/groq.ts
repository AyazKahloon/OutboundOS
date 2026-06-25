// Shared Groq client + a JSON chat helper with retry/backoff on transient errors.
import Groq from "groq-sdk";
import type { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";

let client: Groq | null = null;

export function getGroq(): Groq {
  if (!client) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set");
    client = new Groq({ apiKey });
  }
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Calls Groq in JSON mode, retrying on rate-limit (429) and 5xx with exponential backoff.
// Returns the raw JSON string from the model (caller parses).
export async function groqChatJSON(opts: {
  model: string;
  temperature: number;
  messages: ChatCompletionMessageParam[];
  maxRetries?: number;
}): Promise<string> {
  const groq = getGroq();
  const maxRetries = opts.maxRetries ?? 4;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model: opts.model,
        temperature: opts.temperature,
        response_format: { type: "json_object" },
        messages: opts.messages,
      });
      return completion.choices[0]?.message?.content ?? "{}";
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number }).status ?? 0;
      const msg = (err as { message?: string }).message ?? "";
      // Retry transient errors (429/5xx) AND the occasional malformed-JSON 400 — the model
      // is stochastic, so simply asking again almost always returns valid JSON next time.
      const jsonFail = status === 400 && /json_validate_failed|failed to generate json/i.test(msg);
      const retryable = status === 429 || (status >= 500 && status < 600) || jsonFail;
      if (!retryable || attempt === maxRetries) throw err;
      await sleep(jsonFail ? 300 : 1500 * Math.pow(2, attempt)); // json retries fast; rate-limits back off
    }
  }
  throw lastErr;
}
