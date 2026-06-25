# Development & maintenance guide

How to change things and exactly what to run afterward. For how the system works, see
**HOW_IT_WORKS.md**.

---

## Prerequisites

- **Node.js** (v20+) and **pnpm** (`npm i -g pnpm`)
- **Google Chrome** installed (the scrapers drive it)
- A **Groq API key** (free at console.groq.com) — entered in the app's Settings

First time after cloning / on a new machine:
```bash
pnpm install
```

---

## The golden rule (how changes reach the app)

The packaged `.exe` runs a **bundled copy** of the backend (`desktop/backend.cjs`), not your
source directly. So:

- Editing **backend** code → changes reach the **CLI immediately** (it runs source via tsx),
  but reach the **app only after you rebuild + repackage**.
- Editing **desktop UI** (`renderer/`, `main.js`, `preload.js`) → just relaunch the app in dev;
  to ship it, repackage.

**To rebuild the clickable app after ANY change:**
```bash
pnpm --filter @outboundos/backend build
pnpm --filter @outboundos/desktop run make
```
That regenerates `F:\OutboundOS-app\...\OutboundOS.exe`. The Desktop shortcut keeps working
(it points at that folder). Close the app first if it's open.

---

## Everyday commands

| Goal | Command (run from the repo root) |
|---|---|
| Install dependencies | `pnpm install` |
| Type-check the backend | `pnpm --filter @outboundos/backend lint` |
| Compile the backend | `pnpm --filter @outboundos/backend build` |
| Run the app in dev (live UI) | `pnpm --filter @outboundos/desktop start` |
| Rebuild the `.exe` | `pnpm --filter @outboundos/backend build && pnpm --filter @outboundos/desktop run make` |
| CLI: scrape leads → `leads.json` | `pnpm --filter @outboundos/backend scrape-leads "law firms in Austin TX" 20` |
| CLI: generate emails | `pnpm --filter @outboundos/backend generate-emails leads.json 20` |
| CLI: test one business | `pnpm --filter @outboundos/backend dry-run "Joe's Pizza" "https://site.com" "City, ST"` |

The CLI reads keys/offer from the repo `.env`; the app reads them from its Settings screen.

---

## "I want to change X" → where to edit

| Change | File | Then run |
|---|---|---|
| Email tone / structure / wording | `backend/src/agents/writer.agent.ts` (`SYSTEM_PROMPT`) | rebuild + repackage |
| How many good vs bad reviews | `backend/src/scrapers/gmaps-reviews.ts` (`DEFAULT_SAMPLE`) | rebuild + repackage |
| What the reviews-analyst looks for | `backend/src/agents/reviews-analyst.agent.ts` | rebuild + repackage |
| CSV columns accepted | `backend/src/lib/csv-leads.ts` (`findCol` lists) | rebuild + repackage |
| Which website pages get crawled | `backend/src/scrapers/crawler.ts` (`KEY_PATTERNS`, `MAX_PAGES`) | rebuild + repackage |
| The AI model | `backend/src/config.ts` (`models`) | rebuild + repackage |
| UI look / layout | `desktop/renderer/styles.css`, `index.html`, `renderer.js` | relaunch dev / repackage |
| App icon | replace `desktop/assets/icon.png` (256×256) | repackage |
| Default data folder | `desktop/main.js` (`DEFAULT_DATA_DIR`) | repackage |

**If Google changes its review page** and reviews stop coming through: the CSS selectors are
all in one place — `backend/src/scrapers/gmaps-reviews.ts` (look for `.jftiEf`, `.d4r55`,
`.wiI7pd`, `.kvMYJc`, `.rsqaWe`). Update them, rebuild, repackage. It degrades to "rating only"
rather than crashing, so you'll see emails still generate, just without review text.

**To move to a real database later:** add a new class implementing `LeadStore` in
`backend/src/storage/`, and return it from `createStore()` in `storage/index.js`. Nothing else
changes.

---

## Gotchas (things that will bite you if forgotten)

- **Never put a named function/arrow inside a `page.evaluate(...)` or `$$eval(...)`.** The
  bundler injects a `__name` helper that doesn't exist in the browser → silent failure. Write
  the callback's logic inline. (This bit us twice.)
- **The Maps scraper must run headed** (a Chrome window appears). Don't force
  `SCRAPER_HEADLESS=1` in the app — Google hides reviews from headless Chrome.
- **Keep `backend/src/lib/paths.ts` bundle-safe** — no `import.meta.url` at the top level
  (it's undefined once bundled to the app). It's already wrapped in a guard; leave it that way.
- **System Chrome is required.** Both scrapers use `channel: "chrome"`. If Chrome is missing,
  scraping won't run.
- **`backend/dist` must be built before packaging** — `make` does this for you, but if you run
  `pack.mjs` alone, build first.

---

## Packaging notes

- We use **@electron/packager** (`desktop/pack.mjs`), not electron-builder — electron-builder's
  code-signing tool can't unpack on this machine without admin/Developer Mode.
- Output goes to **F:** (`F:\OutboundOS-app`) because C: is low on space. The Electron binary
  cache is also pointed at F: via `ELECTRON_CACHE` (set automatically isn't needed for `make`,
  but if a fresh download is required: `set ELECTRON_CACHE=F:\electron-cache` first).
- The result is a **portable folder** with `OutboundOS.exe` — no installer. Don't move/rename
  the folder or the Desktop shortcut breaks (recreate the shortcut to the new path if you do).
- It is **not code-signed**, so Windows SmartScreen may warn on first launch → "More info →
  Run anyway". Signing requires a paid certificate.

---

## Generated files (safe to delete; regenerate on next build/run)

- `desktop/backend.cjs`, `desktop/xhr-sync-worker.js`, `desktop/node_modules/playwright*`
  (from `build.mjs`)
- `backend/dist/` (from `build`)
- `leads*.json/csv`, `generated*.md/csv` at the repo root (CLI outputs)
- `F:\OutboundOS\.maps-profile` (the warmed Chrome profile — re-warms automatically)
