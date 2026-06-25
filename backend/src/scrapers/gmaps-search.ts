// In-house Google Maps search scraper — turn a query like "law firms in Austin TX"
// into a list of businesses. No API, no cost. Uses the same real-Chrome Maps context.
//
// We read only the high-confidence fields from each result card (name, place URL, rating,
// review count). Website/phone/address come later from each place panel (more reliable).
import { getMapsContext, humanDelay, sleep } from "../lib/browser.js";

export interface SearchResult {
  name: string;
  placeUrl: string;
  rating: number | null;
  reviewCount: number | null;
}

const NAV_TIMEOUT = 30_000;

// Serialize Maps access (shared intent with the reviews tool, but its own lock is fine
// because the lead script runs search THEN per-place reviews sequentially).
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(() => {}, () => {});
  return run as Promise<T>;
}

export async function searchPlaces(query: string, max = 40): Promise<SearchResult[]> {
  return withLock(async () => {
    const ctx = await getMapsContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);
    try {
      await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(query)}?hl=en&gl=us`, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT,
      });
      await humanDelay(1500, 2500);

      // Scroll the results feed until we have enough cards or it stops growing.
      const feed = page.locator('div[role="feed"]').first();
      let stable = 0;
      let last = 0;
      for (let i = 0; i < 30 && stable < 3; i++) {
        const count = await page.locator("a.hfpxzc").count();
        if (count >= max) break;
        stable = count === last ? stable + 1 : 0;
        last = count;
        await feed.evaluate((el) => el.scrollBy(0, 2500)).catch(() => page.mouse.wheel(0, 2500));
        await sleep(750);
      }

      // Extract one entry per result card (inline — no helper fns, keeps tsx/esbuild happy).
      const results = await page.$$eval("div.Nv2PK", (cards) =>
        cards.map((c) => {
          const reviewsRaw = c.querySelector("span.UY7F9")?.textContent ?? "";
          const ratingRaw = c.querySelector("span.MW4etd")?.textContent ?? "";
          return {
            name: c.querySelector("div.qBF1Pd")?.textContent?.trim() ?? c.querySelector("a.hfpxzc")?.getAttribute("aria-label")?.trim() ?? "",
            placeUrl: c.querySelector("a.hfpxzc")?.getAttribute("href") ?? "",
            rating: Number(ratingRaw.match(/\d[.,]\d/)?.[0]?.replace(",", ".")) || null,
            reviewCount: Number(reviewsRaw.replace(/[^\d]/g, "")) || null,
          };
        })
      );

      // Dedupe by place URL, keep only ones with a usable URL + name.
      const seen = new Set<string>();
      const clean: SearchResult[] = [];
      for (const r of results) {
        if (!r.name || !r.placeUrl || seen.has(r.placeUrl)) continue;
        seen.add(r.placeUrl);
        clean.push(r);
        if (clean.length >= max) break;
      }
      return clean;
    } finally {
      await page.close().catch(() => {});
    }
  });
}
