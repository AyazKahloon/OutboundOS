// Shared LOCAL browsers we drive ourselves — no third-party API, no cost.
//
// Two surfaces with different needs:
//  • getBrowser()/newContext() — bundled Chromium, fine for crawling ordinary websites.
//  • getMapsContext()          — REAL Chrome with a persistent, warmed profile. Google
//    serves a reviews-suppressed Maps layout to fresh/automation-flagged sessions; a
//    persistent real-Chrome profile that has cookies (looks like a returning user) gets
//    the full layout with review text. This is the durable unlock for review scraping.
import { chromium, type Browser, type BrowserContext } from "playwright";
import { resolve } from "node:path";
import { DATA_DIR } from "./paths.js";

let browser: Browser | null = null;
let browserPromise: Promise<Browser> | null = null;
let mapsCtx: BrowserContext | null = null;
let mapsInit: Promise<BrowserContext> | null = null;

// Persisted across runs so the profile stays "warm" (gitignored under the data dir).
const MAPS_PROFILE_DIR = process.env.MAPS_PROFILE_DIR ?? resolve(DATA_DIR, ".maps-profile");

// A realistic desktop UA + a couple of automation-hiding launch args. This is not
// bulletproof against Google's bot detection, but it's enough for low-volume scraping.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-dev-shm-usage",
];

// Headless by default (faster, non-intrusive). Set SCRAPER_HEADLESS=0 to watch it run.
// It's a local browser either way — no API, no cost.
const HEADLESS = process.env.SCRAPER_HEADLESS !== "0";

// Single-flight: concurrent callers share one launch instead of racing two browsers.
export function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    // Use the user's installed Google Chrome (channel "chrome") rather than a bundled
    // Chromium — so nothing needs downloading and the packaged app has no browser binaries.
    browserPromise = chromium
      .launch({ headless: HEADLESS, channel: "chrome", args: LAUNCH_ARGS })
      .then((b) => (browser = b))
      .catch((e) => {
        browserPromise = null; // allow a later retry
        throw e;
      });
  }
  return browserPromise;
}

// Fresh context per task = isolated cookies/cache, so one site's state can't bleed
// into the next. Locale/timezone are pinned to look like a normal US visitor.
export async function newContext(): Promise<BrowserContext> {
  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent: USER_AGENT,
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1366, height: 900 },
    serviceWorkers: "block",
  });
  // Hide the most obvious automation tell.
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return ctx;
}

// Persistent REAL Chrome context for Google Maps. Headed by default (headless real Chrome
// is more likely to be re-flagged); set SCRAPER_HEADLESS=1 to force headless.
// Single-flight so concurrent callers can't launch two Chromes on the same profile dir.
export function getMapsContext(): Promise<BrowserContext> {
  if (!mapsInit) {
    mapsInit = initMapsContext().catch((e) => {
      mapsInit = null; // allow a later retry
      throw e;
    });
  }
  return mapsInit;
}

async function initMapsContext(): Promise<BrowserContext> {
  let ctx: BrowserContext;
  try {
    ctx = await chromium.launchPersistentContext(MAPS_PROFILE_DIR, {
      channel: "chrome", // the user's installed Google Chrome, not the detectable bundled build
      headless: process.env.SCRAPER_HEADLESS === "1",
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      args: LAUNCH_ARGS,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (/singleton|profile|in use|process|cannot create|lock/i.test(msg)) {
      throw new Error(
        `Could not open the Maps Chrome profile at ${MAPS_PROFILE_DIR}.\n` +
          `A Chrome using this profile is probably still running (a leftover scrape), or the\n` +
          `profile is locked. Close stray Chrome windows, or delete "${MAPS_PROFILE_DIR}" to\n` +
          `start fresh (it will re-warm automatically), then retry.\nOriginal error: ${msg}`
      );
    }
    throw err;
  }
  mapsCtx = ctx;
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Warm the profile once: a throwaway Maps visit so Google sets its cookies (NID etc.)
  // and treats us as a returning user on the real place pages that follow.
  const page = await ctx.newPage();
  try {
    await page.goto("https://www.google.com/maps?hl=en&gl=us", { waitUntil: "domcontentloaded", timeout: 30_000 });
    for (const sel of ['button[aria-label*="Accept all" i]', 'form[action*="consent"] button']) {
      try {
        const b = page.locator(sel).first();
        if (await b.isVisible({ timeout: 1500 })) {
          await b.click();
          break;
        }
      } catch {
        /* none shown */
      }
    }
    await sleep(2500);
  } catch {
    /* warmup is best-effort */
  } finally {
    await page.close().catch(() => {});
  }
  return ctx;
}

export async function closeBrowser(): Promise<void> {
  if (mapsCtx) await mapsCtx.close().catch(() => {});
  mapsCtx = null;
  mapsInit = null;
  if (browser) await browser.close().catch(() => {});
  browser = null;
  browserPromise = null;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Small randomized pause to look less robotic between actions.
export const humanDelay = (min = 400, max = 1200): Promise<void> =>
  sleep(min + Math.floor((max - min) * pseudoRandom()));

// Deterministic-ish jitter without Math.random (kept simple; seed drifts via time-free counter).
let _tick = 0;
function pseudoRandom(): number {
  _tick = (_tick * 9301 + 49297) % 233280;
  return _tick / 233280;
}
