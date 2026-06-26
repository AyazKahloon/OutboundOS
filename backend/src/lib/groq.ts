// Shared Groq client + a JSON chat helper that RESPECTS rate limits and keeps going.
//
// Strategy:
//  • Client-side token bucket paces calls to stay under requests/min AND tokens/min, so we
//    mostly never hit a 429 in the first place. Works across concurrent callers.
//  • If we still get a 429, we honor Groq's Retry-After (wait the exact time, then retry) —
//    the run keeps going instead of failing. A very long wait (daily cap) surfaces a clear error.
//  • 5xx and the occasional malformed-JSON 400 are retried too.
//
// Tune via env: GROQ_RPM (default 25), GROQ_TPM (default 10000). Lower them if you see lots of
// waiting; raise them on a paid tier.
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

// ---- client-side rate limiter (token bucket, shared across callers) --------
// Defaults tuned for openai/gpt-oss-120b free tier (30 RPM / 8K TPM), with safety margin.
const RPM = Math.max(1, Number(process.env.GROQ_RPM) || 25);
const TPM = Math.max(1000, Number(process.env.GROQ_TPM) || 7000);

let reqBucket = RPM;
let tokBucket = TPM;
let lastRefill = Date.now();
let gate: Promise<unknown> = Promise.resolve(); // serializes the acquire logic

function refill(): void {
  const now = Date.now();
  const elapsed = now - lastRefill;
  if (elapsed <= 0) return;
  reqBucket = Math.min(RPM, reqBucket + (elapsed / 60_000) * RPM);
  tokBucket = Math.min(TPM, tokBucket + (elapsed / 60_000) * TPM);
  lastRefill = now;
}

function estimateTokens(messages: ChatCompletionMessageParam[]): number {
  const chars = messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
  return Math.ceil(chars / 4) + 500; // rough input estimate + output budget
}

// Wait until the buckets allow one request of ~estTokens, then consume. Serialized so
// concurrent callers can't double-spend the budget.
async function acquire(estTokens: number): Promise<void> {
  const need = Math.min(estTokens, TPM);
  const run = gate.then(async () => {
    for (;;) {
      refill();
      if (reqBucket >= 1 && tokBucket >= need) {
        reqBucket -= 1;
        tokBucket -= need;
        return;
      }
      const waitReq = reqBucket >= 1 ? 0 : ((1 - reqBucket) / RPM) * 60_000;
      const waitTok = tokBucket >= need ? 0 : ((need - tokBucket) / TPM) * 60_000;
      await sleep(Math.max(50, Math.ceil(Math.max(waitReq, waitTok))));
    }
  });
  gate = run.then(
    () => {},
    () => {}
  );
  return run;
}

// Pull a "wait this long" hint out of a 429 (header or message).
function retryAfterMs(err: unknown): number | null {
  const e = err as { headers?: Record<string, string>; message?: string };
  const h = e.headers?.["retry-after"];
  if (h && !Number.isNaN(Number(h))) return Number(h) * 1000;
  const m = e.message?.match(/try again in ([\d.]+)\s*s/i);
  if (m) return Math.ceil(parseFloat(m[1]!) * 1000);
  return null;
}

export async function groqChatJSON(opts: {
  model: string;
  temperature: number;
  messages: ChatCompletionMessageParam[];
  maxRetries?: number;
}): Promise<string> {
  const groq = getGroq();
  const maxServerRetries = opts.maxRetries ?? 5;
  const est = estimateTokens(opts.messages);
  let serverRetries = 0;
  let rateWaits = 0;

  for (;;) {
    await acquire(est);
    try {
      const completion = await groq.chat.completions.create({
        model: opts.model,
        temperature: opts.temperature,
        response_format: { type: "json_object" },
        messages: opts.messages,
      });
      return completion.choices[0]?.message?.content ?? "{}";
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      const msg = (err as { message?: string }).message ?? "";

      // Rate limited → wait the suggested time and keep going (don't count toward hard retries).
      if (status === 429) {
        const wait = retryAfterMs(err) ?? 2000 * Math.min(rateWaits + 1, 8);
        if (wait > 90_000 || ++rateWaits > 30) {
          throw new Error(`Groq rate/daily limit reached — try again later (suggested wait ${Math.round(wait / 1000)}s).`);
        }
        // Empty the buckets so other in-flight callers also back off.
        reqBucket = 0;
        tokBucket = 0;
        lastRefill = Date.now();
        await sleep(wait);
        continue;
      }

      // Occasional malformed JSON → quick retry (the model is stochastic).
      const jsonFail = status === 400 && /json_validate_failed|failed to generate json/i.test(msg);
      const retryable = jsonFail || (status >= 500 && status < 600);
      if (!retryable || serverRetries >= maxServerRetries) throw err;
      serverRetries++;
      await sleep(jsonFail ? 300 : 1500 * Math.pow(2, serverRetries - 1));
    }
  }
}
