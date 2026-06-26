// In-house website crawler — replaces Firecrawl. No API, no cost.
// Given a site URL: load the homepage in our own headless browser, discover a few
// high-signal internal pages (about / services / team / contact), render each, and
// extract clean markdown with Mozilla Readability + Turndown.
import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { newContext, humanDelay } from "../lib/browser.js";

// Swallow jsdom's noisy "Could not parse CSS stylesheet" errors from messy real-world
// sites — they're harmless for text extraction and otherwise spam the console.
const quietConsole = new VirtualConsole();
quietConsole.on("jsdomError", () => {});

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.remove(["script", "style", "noscript", "form", "nav", "footer"]);

// Internal links whose path/text hints at a high-value page. Order = priority.
const KEY_PATTERNS: RegExp[] = [
  /about|who-?we-?are|our-?firm|firm-?overview/i,
  /practice|service|what-?we-?do|expertise/i,
  /team|attorney|lawyer|our-?people|staff/i,
  /contact/i,
];

const MAX_PAGES = 6; // homepage + up to 5 key pages
const PER_PAGE_TIMEOUT = 20_000;
const MAX_CHARS_PER_PAGE = 4_000;
const MAX_TOTAL_CHARS = 14_000;

export interface CrawledPage {
  url: string;
  title: string;
  markdown: string;
}

export interface CrawlResult {
  homepageUrl: string;
  pages: CrawledPage[];
  combinedMarkdown: string;
  email: string; // best contact email found on the site ("" if none)
  siteSignals: string; // what the business appears to already have / lack online
}

// ---- contact-email extraction ----------------------------------------------
// Search mode has no email from Google Maps, so we harvest one from the site itself.
const JUNK_EMAIL_DOMAINS = [
  "example.com", "example.org", "sentry.io", "wixpress.com", "wix.com", "godaddy.com",
  "squarespace.com", "domain.com", "email.com", "yourdomain.com", "your-email.com",
  "company.com", "mysite.com", "test.com", "sentry-next.wixpress.com",
];
const ROLE_PREFIXES = ["info", "contact", "hello", "hi", "office", "admin", "sales", "team", "support", "enquiries", "inquiries", "reception", "mail"];

interface EmailHit {
  mailto: boolean;
  sameDomain: boolean;
}

function isUsableEmail(e: string): boolean {
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) return false;
  if (/\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$/i.test(e)) return false; // asset@2x.png etc.
  if (/@\d+x\./.test(e)) return false;
  const domain = e.split("@")[1]!;
  return !JUNK_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
}

function collectEmails(html: string, siteHost: string, into: Map<string, EmailHit>): void {
  const add = (raw: string, mailto: boolean) => {
    const e = decodeURIComponent(raw).split("?")[0]!.trim().toLowerCase();
    if (!isUsableEmail(e)) return;
    const domain = e.split("@")[1]!;
    const sameDomain = domain === siteHost || domain.endsWith("." + siteHost);
    const prev = into.get(e);
    into.set(e, { mailto: mailto || Boolean(prev?.mailto), sameDomain });
  };
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) add(m[1]!, true);
  for (const m of html.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)) add(m[0]!, false);
}

// Prefer the business's own domain, then a real mailto link, then a role inbox (info@ …).
function pickBestEmail(hits: Map<string, EmailHit>): string {
  let best = "";
  let bestScore = -1;
  for (const [e, h] of hits) {
    let score = (h.sameDomain ? 4 : 0) + (h.mailto ? 2 : 0) + (ROLE_PREFIXES.includes(e.split("@")[0]!) ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

// ---- "what they already have / lack online" detection ----------------------
// Lets the email pitch the RIGHT thing and not pitch something they already have.
// Vendor-name patterns are used where possible to avoid false positives.
const SIGNALS: [string, string, RegExp][] = [
  ["booking", "online booking/scheduling", /calendly|acuity|setmore|simplybook|opentable|resy|squareup\.com\/book|book\s*(now|online|an?\s*appointment)|schedule\s*an?\s*appointment/i],
  ["chat", "a live chat or chatbot", /intercom|drift\.com|tawk\.to|crisp\.chat|tidio|zendesk|livechatinc|hubspot|fb-customerchat|customerchat|botpress/i],
  ["whatsapp", "WhatsApp contact", /wa\.me|api\.whatsapp\.com|whatsapp/i],
  ["ecommerce", "online ordering/store", /add[\s-]?to[\s-]?cart|shopify|woocommerce|snipcart|\/checkout|order\s*online/i],
  ["app", "a mobile app", /apps\.apple\.com|play\.google\.com\/store/i],
];
const CONTACT_FORM = /<form|contact\s*us|get\s*in\s*touch|enquir|inquiry/i;

function detectSignals(html: string, flags: Set<string>): void {
  for (const [key, , re] of SIGNALS) if (re.test(html)) flags.add(key);
  if (CONTACT_FORM.test(html)) flags.add("contactform");
}

function summarizeSignals(flags: Set<string>): string {
  const has: string[] = [];
  const missing: string[] = [];
  for (const [key, label] of SIGNALS) (flags.has(key) ? has : missing).push(label);
  const parts: string[] = [];
  if (has.length) parts.push(`Appears to already have: ${has.join(", ")}.`);
  if (missing.length) parts.push(`Not found on the site: ${missing.join(", ")}.`);
  if (flags.has("contactform") && !flags.has("chat") && !flags.has("whatsapp") && !flags.has("booking")) {
    parts.push("The only obvious way to reach them online is a basic contact form.");
  }
  return parts.join(" ");
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Pull readable content out of raw HTML. Falls back to <body> text if Readability bails.
function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const dom = new JSDOM(html, { url, virtualConsole: quietConsole });
  const doc = dom.window.document;
  try {
    const article = new Readability(doc).parse();
    if (article?.content && article.textContent && article.textContent.trim().length > 120) {
      return { title: article.title ?? doc.title ?? "", markdown: turndown.turndown(article.content) };
    }
  } catch {
    // fall through to body extraction
  }
  const body = doc.body?.innerHTML ?? "";
  return { title: doc.title ?? "", markdown: turndown.turndown(body) };
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.replace(/^www\./, "") === new URL(b).host.replace(/^www\./, "");
  } catch {
    return false;
  }
}

// Rank candidate links: keep same-host links that match a key pattern, best-first,
// at most one per pattern bucket so we get variety (about + services + team + contact).
function pickKeyLinks(base: string, links: { href: string; text: string }[]): string[] {
  const seen = new Set<string>();
  const picked: string[] = [];
  for (const pattern of KEY_PATTERNS) {
    for (const { href, text } of links) {
      if (!sameHost(base, href)) continue;
      const clean = href.split("#")[0]!;
      if (seen.has(clean) || clean === base) continue;
      if (pattern.test(clean) || pattern.test(text)) {
        picked.push(clean);
        seen.add(clean);
        break; // one per bucket
      }
    }
  }
  return picked.slice(0, MAX_PAGES - 1);
}

export async function crawlSite(websiteUrl: string): Promise<CrawlResult> {
  const ctx = await newContext();
  const pages: CrawledPage[] = [];
  const emailHits = new Map<string, EmailHit>();
  const signalFlags = new Set<string>();
  let siteHost = "";
  try {
    siteHost = new URL(websiteUrl).host.replace(/^www\./, "");
  } catch {
    /* leave blank */
  }
  try {
    const page = await ctx.newPage();
    // Skip images/media to crawl faster — we only want text.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") return route.abort();
      return route.continue();
    });

    // 1) Homepage.
    await page.goto(websiteUrl, { waitUntil: "domcontentloaded", timeout: PER_PAGE_TIMEOUT });
    await humanDelay();
    const homeHtml = await page.content();
    collectEmails(homeHtml, siteHost, emailHits);
    detectSignals(homeHtml, signalFlags);
    const home = htmlToMarkdown(homeHtml, websiteUrl);
    pages.push({ url: websiteUrl, title: home.title, markdown: truncate(home.markdown, MAX_CHARS_PER_PAGE) });

    // 2) Discover internal key pages from the homepage's links.
    const links = await page.$$eval("a[href]", (els) =>
      els.map((e) => ({ href: (e as HTMLAnchorElement).href, text: (e.textContent ?? "").trim() }))
    );
    const keyLinks = pickKeyLinks(websiteUrl, links);

    // 3) Visit each key page.
    for (const link of keyLinks) {
      try {
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: PER_PAGE_TIMEOUT });
        await humanDelay();
        const html = await page.content();
        collectEmails(html, siteHost, emailHits);
        detectSignals(html, signalFlags);
        const { title, markdown } = htmlToMarkdown(html, link);
        if (markdown.trim()) pages.push({ url: link, title, markdown: truncate(markdown, MAX_CHARS_PER_PAGE) });
      } catch (err) {
        console.warn(`[crawler] page failed ${link}: ${(err as Error).message}`);
      }
    }
  } finally {
    await ctx.close();
  }

  // Stitch pages into one document, respecting a global budget.
  let total = 0;
  const parts: string[] = [];
  for (const p of pages) {
    if (total >= MAX_TOTAL_CHARS) break;
    const chunk = `## ${p.title || p.url}\n(${p.url})\n\n${p.markdown}`;
    parts.push(chunk);
    total += chunk.length;
  }

  return {
    homepageUrl: websiteUrl,
    pages,
    combinedMarkdown: truncate(parts.join("\n\n---\n\n"), MAX_TOTAL_CHARS),
    email: pickBestEmail(emailHits),
    siteSignals: summarizeSignals(signalFlags),
  };
}
