// In-house Google Maps place + reviews scraper — no API, no cost.
//
// DURABILITY DESIGN (validated 2026-06-24):
//  • Anti-suppression: drive the user's REAL Chrome via a persistent, warmed profile
//    (see getMapsContext). Fresh/automation-flagged sessions get a reviews-less layout.
//  • Balanced sampling: we pull the most-relevant reviews AND the lowest-rated ones, because
//    negative reviews are where the real pain points (and our "stop leaking revenue" hook) live.
//  • Extraction: DOM cards (div.jftiEf) keyed on the stable data-review-id; selectors are
//    centralized here for easy updates if Google's classes drift.
//  • Access is serialized (one Maps page at a time) to avoid tripping rate limits.
import type { Page, BrowserContext } from "playwright";
import { getMapsContext, humanDelay, sleep } from "../lib/browser.js";

export interface GoogleReview {
  id: string;
  author: string;
  rating: number | null; // 1-5
  text: string;
  relativeTime: string; // e.g. "3 weeks ago"
}

export interface ReviewsResult {
  placeUrl: string;
  averageRating: number | null;
  totalReviews: number | null;
  reviews: GoogleReview[];
  blocked: boolean;
  note?: string;
}

// A full business lead: place details + a balanced review sample.
export interface PlaceLead {
  name: string;
  placeUrl: string;
  website: string;
  phone: string;
  address: string;
  category: string;
  rating: number | null;
  totalReviews: number | null;
  reviews: GoogleReview[];
  note?: string;
}

export interface ReviewSampleOpts {
  highest?: number; // top-rated reviews to pull (for genuine flattery)
  lowest?: number; // lowest-rated reviews to pull (pain points to pitch against)
  relevant?: number; // optional: most-relevant reviews (extra context)
}

// Default sample: a few glowing reviews to compliment them on, plus more critical ones to
// surface real pain points (lost revenue / wasted time) for the pitch.
const DEFAULT_SAMPLE = { highest: 3, lowest: 5 };

const NAV_TIMEOUT = 30_000;

// Serialize all Maps access — one place at a time, regardless of caller concurrency.
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(() => {}, () => {});
  return run as Promise<T>;
}

async function looksBlocked(page: Page): Promise<boolean> {
  if (/sorry\/index|captcha/i.test(page.url())) return true;
  try {
    const body = (await page.locator("body").innerText({ timeout: 2000 })).toLowerCase();
    return body.includes("unusual traffic") || body.includes("not a robot");
  } catch {
    return false;
  }
}

// Navigate to a place: prefer a direct place URL; otherwise search by name+address.
async function gotoPlace(page: Page, input: { name?: string; address?: string; placeUrl?: string }): Promise<boolean> {
  if (input.placeUrl) {
    await page.goto(input.placeUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
    await humanDelay();
    return /\/maps\/place\//.test(page.url());
  }
  const query = [input.name, input.address].filter(Boolean).join(", ");
  if (!query.trim()) return false;
  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en&gl=us`, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT,
  });

  // Maps is an SPA: for a single match it auto-redirects to /maps/place/ a beat after load.
  // Wait for either that redirect OR the first result link to render, instead of guessing.
  await page
    .waitForURL(/\/maps\/place\//, { timeout: 9000 })
    .catch(() => page.locator('a.hfpxzc, a[href*="/maps/place/"]').first().waitFor({ state: "visible", timeout: 9000 }).catch(() => {}));

  if (/\/maps\/place\//.test(page.url())) return true;

  try {
    const first = page.locator('a.hfpxzc, a[href*="/maps/place/"]').first();
    if (await first.isVisible({ timeout: 3000 })) {
      const href = await first.getAttribute("href");
      if (href) {
        await page.goto(href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
        await page.waitForURL(/\/maps\/place\//, { timeout: 9000 }).catch(() => {});
        return /\/maps\/place\//.test(page.url());
      }
    }
  } catch {
    /* no result */
  }
  return false;
}

// Header rating + total review count (above the tabs).
async function readHeaderStats(page: Page): Promise<{ rating: number | null; total: number | null }> {
  try {
    const block = await page.locator("div.F7nice").first().innerText({ timeout: 4000 });
    const rating = block.match(/(\d[.,]\d)/)?.[1]?.replace(",", ".");
    const total = block.match(/([\d.,]+)\s*review/i)?.[1]?.replace(/[.,]/g, "");
    return { rating: rating ? Number(rating) : null, total: total ? Number(total) : null };
  } catch {
    return { rating: null, total: null };
  }
}

// Website / phone / address / category from the place panel (reliable, attribute-based).
async function readPlaceDetails(page: Page): Promise<{ website: string; phone: string; address: string; category: string }> {
  try {
    // NOTE: keep this callback free of nested named functions — tsx/esbuild injects a
    // `__name` helper for them that is undefined in the page, which throws at runtime.
    const raw = await page.evaluate(() => ({
      website: document.querySelector('a[data-item-id="authority"]')?.getAttribute("href") ?? "",
      phoneAria: document.querySelector('button[data-item-id^="phone"]')?.getAttribute("aria-label") ?? "",
      addressAria: document.querySelector('button[data-item-id="address"]')?.getAttribute("aria-label") ?? "",
      category: document.querySelector("button.DkEaL")?.textContent?.trim() ?? "",
    }));
    return {
      website: raw.website,
      phone: raw.phoneAria.replace(/^Phone:\s*/i, "").trim(),
      address: raw.addressAria.replace(/^Address:\s*/i, "").trim(),
      category: raw.category,
    };
  } catch {
    return { website: "", phone: "", address: "", category: "" };
  }
}

async function openReviewsTab(page: Page): Promise<boolean> {
  for (const sel of [
    'button[role="tab"][aria-label^="Reviews" i]',
    'button[aria-label*="Reviews for" i]',
    'button[role="tab"]:has-text("Reviews")',
  ]) {
    try {
      const tab = page.locator(sel).first();
      if (await tab.isVisible({ timeout: 3000 })) {
        await tab.click();
        await humanDelay(900, 1600);
        return true;
      }
    } catch {
      /* try next */
    }
  }
  return false;
}

// Set the review sort order (label: "Most relevant" | "Newest" | "Highest rating" | "Lowest rating").
async function sortReviews(page: Page, label: string): Promise<void> {
  try {
    const sortBtn = page.locator('button[aria-label="Sort reviews"], button[aria-label*="Sort" i]').first();
    if (!(await sortBtn.isVisible({ timeout: 2500 }))) return;
    await sortBtn.click();
    await humanDelay(500, 900);
    const item = page.locator(`[role="menuitemradio"]:has-text("${label}"), [role="menuitem"]:has-text("${label}")`).first();
    if (await item.isVisible({ timeout: 2000 })) {
      await item.click();
      await humanDelay(1000, 1600); // let the list re-sort/reload
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
  } catch {
    /* sorting is best-effort */
  }
}

// Scroll the reviews list until `target` cards are loaded (or it stops growing).
async function loadReviewCards(page: Page, target: number): Promise<void> {
  let stable = 0;
  let last = 0;
  for (let i = 0; i < 25 && stable < 3; i++) {
    const count = await page.locator("div.jftiEf").count();
    if (count >= target) break;
    stable = count === last ? stable + 1 : 0;
    last = count;
    await page
      .locator("div.jftiEf")
      .last()
      .evaluate((el) => {
        let p: HTMLElement | null = el.parentElement;
        while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement;
        (p ?? el).scrollTop = (p ?? el).scrollHeight;
      })
      .catch(() => page.mouse.wheel(0, 2500));
    await sleep(800);
  }
  // Expand "See more" so we capture full review text.
  try {
    const more = page.locator('div.jftiEf button[aria-label="See more"], div.jftiEf button.w8nwRe');
    const n = Math.min(await more.count(), target);
    for (let i = 0; i < n; i++) await more.nth(i).click({ timeout: 700 }).catch(() => {});
  } catch {
    /* nothing to expand */
  }
}

async function extractCards(page: Page, max: number): Promise<GoogleReview[]> {
  return page.$$eval(
    "div.jftiEf",
    (cards, max) =>
      cards.slice(0, max).map((c) => ({
        id: c.getAttribute("data-review-id") ?? "",
        author: c.querySelector(".d4r55")?.textContent?.trim() ?? "",
        text: (c.querySelector(".wiI7pd") ?? c.querySelector(".MyEned"))?.textContent?.trim() ?? "",
        relativeTime: c.querySelector(".rsqaWe")?.textContent?.trim() ?? "",
        rating:
          Number(
            (c.querySelector(".kvMYJc") ?? c.querySelector('[role="img"][aria-label*="star" i]'))
              ?.getAttribute("aria-label")
              ?.match(/\d/)?.[0]
          ) || null,
      })),
    max
  );
}

// Gather top-rated (flattery) + lowest-rated (pain points), deduped by review id.
async function gatherReviews(page: Page, opts: ReviewSampleOpts): Promise<GoogleReview[]> {
  const highest = opts.highest ?? DEFAULT_SAMPLE.highest;
  const lowest = opts.lowest ?? DEFAULT_SAMPLE.lowest;
  const relevant = opts.relevant ?? 0;
  const byId = new Map<string, GoogleReview>();

  const collect = async (label: string, n: number) => {
    if (n <= 0) return;
    await sortReviews(page, label);
    await loadReviewCards(page, n);
    for (const r of await extractCards(page, n)) if (r.id || r.text) byId.set(r.id || r.text, r);
  };

  await collect("Highest rating", highest);
  await collect("Lowest rating", lowest);
  await collect("Most relevant", relevant);
  return [...byId.values()];
}

// ---- Public API -----------------------------------------------------------

// Used by the email pipeline. Returns a balanced review sample + header rating.
export async function scrapeGoogleReviews(
  input: { name?: string; address?: string; placeUrl?: string },
  opts: ReviewSampleOpts = {}
): Promise<ReviewsResult> {
  return withLock(async () => {
    let page: Page | null = null;
    try {
      const ctx = await getMapsContext();
      page = await ctx.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT);

      const ok = await gotoPlace(page, input);
      if (await looksBlocked(page)) return blockedResult();
      if (!ok) return { placeUrl: page.url(), averageRating: null, totalReviews: null, reviews: [], blocked: false, note: "place not found" };

      const { rating, total } = await readHeaderStats(page);
      const hasReviews = await openReviewsTab(page);
      if (!hasReviews) {
        return { placeUrl: page.url(), averageRating: rating, totalReviews: total, reviews: [], blocked: false, note: "no Reviews tab (profile may need warming)" };
      }
      const reviews = await gatherReviews(page, opts);
      return { placeUrl: page.url(), averageRating: rating, totalReviews: total, reviews, blocked: false, note: reviews.length ? undefined : "no reviews extracted" };
    } catch (err) {
      return { placeUrl: "", averageRating: null, totalReviews: null, reviews: [], blocked: false, note: `error: ${(err as Error).message}` };
    } finally {
      if (page) await page.close().catch(() => {});
    }
  });
}

// Used by the lead scraper. Opens a place once and returns full details + reviews.
export async function scrapePlace(
  input: { name?: string; address?: string; placeUrl?: string },
  opts: ReviewSampleOpts = {}
): Promise<PlaceLead> {
  return withLock(async () => {
    let page: Page | null = null;
    const base: PlaceLead = {
      name: input.name ?? "",
      placeUrl: input.placeUrl ?? "",
      website: "",
      phone: "",
      address: input.address ?? "",
      category: "",
      rating: null,
      totalReviews: null,
      reviews: [],
    };
    try {
      const ctx = await getMapsContext();
      page = await ctx.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT);

      const ok = await gotoPlace(page, input);
      if (await looksBlocked(page)) return { ...base, note: "blocked by Google" };
      if (!ok) return { ...base, note: "place not found" };

      base.placeUrl = page.url();
      const h1 = await page.locator("h1").first().innerText({ timeout: 4000 }).catch(() => "");
      if (h1) base.name = h1.trim();

      // Wait for the place action row (website/phone/address) to render before reading it.
      await page
        .waitForSelector('a[data-item-id="authority"], button[data-item-id^="phone"], button[data-item-id="address"]', { timeout: 6000 })
        .catch(() => {});
      const details = await readPlaceDetails(page);
      base.website = details.website;
      base.phone = details.phone;
      base.address = details.address || base.address;
      base.category = details.category;

      const { rating, total } = await readHeaderStats(page);
      base.rating = rating;
      base.totalReviews = total;

      if (await openReviewsTab(page)) {
        base.reviews = await gatherReviews(page, opts);
      } else {
        base.note = "no Reviews tab";
      }
      return base;
    } catch (err) {
      return { ...base, note: `error: ${(err as Error).message}` };
    } finally {
      if (page) await page.close().catch(() => {});
    }
  });
}

function blockedResult(): ReviewsResult {
  return { placeUrl: "", averageRating: null, totalReviews: null, reviews: [], blocked: true, note: "blocked by Google (captcha/unusual traffic)" };
}
