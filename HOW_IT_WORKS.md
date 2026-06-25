# How OutboundOS works

A plain-English tour of the whole system. For "how to change things and what commands to
run," see **DEVELOPMENT.md**.

---

## 1. What it does

You give it businesses (a Google Maps search **or** a CSV). For each business it:

1. **Crawls the business's website** (a few key pages).
2. **Reads its Google reviews** — a few of the best (to compliment them) and a few of the
   worst (to find real pain points).
3. **Writes a personalized email** with an AI: a genuine compliment → a problem that's
   quietly costing them time and money → how you can help → a soft question.
4. Lets you **review, approve, and send** the emails from one or more of your mailboxes.

**The only paid service is the Groq AI.** All the scraping/crawling runs locally on your PC
using your installed Google Chrome — no scraping APIs, no per-business cost.

---

## 2. The flow

```
  LEADS IN
  ├─ Search mode:  "dentists in Austin TX"  → finds businesses on Google Maps
  └─ CSV mode:     a file with name, address, website, decision-maker email
        │
        ▼  (for each business)
  GATHER
  ├─ Website crawler   → key pages → clean text
  └─ Reviews scraper   → 3 top-rated + 5 worst-rated reviews
        │
        ▼
  THINK (3 AI agents, in order)
  ├─ Researcher        : website text   → what they do, hooks, pain points
  ├─ Reviews-analyst   : reviews        → praise to use + gaps that cost time/money
  └─ Writer            : all of it      → the email (subject + body)
        │
        ▼
  SAVE   → a "run" stored on disk (F:\OutboundOS\runs\*.json)
        │
        ▼
  REVIEW & SEND (in the app)
  └─ Approve each draft → pick a mailbox → Send → logged in the "Sent" tab
```

---

## 3. The agents and how they collaborate

They run **one after another**, each producing structured data the next one uses. Each only
sees its own source, so they can't make things up from each other's data.

| Agent | Reads | Produces |
|---|---|---|
| **Researcher** (`agents/researcher.agent.ts`) | the crawled website text | `{ whatTheyDo, recentNews, painPoints, hooks }` |
| **Reviews-analyst** (`agents/reviews-analyst.agent.ts`) | the scraped reviews | `{ commonPraise, complaints, serviceGaps, reviewHooks }` |
| **Writer** (`agents/writer.agent.ts`) | both of the above + your offer | `{ subject, body }` |

The split matters: praise comes from real positive reviews (so the compliment is genuine),
and the pitch comes from real complaints/gaps (so it's relevant). The writer is told to
sound human, avoid sales clichés, and tailor "how we help" to that specific business.

Everything degrades gracefully: no website → research from reviews only; no reviews → research
from the site only; a bad AI response → it retries automatically.

*(There's also a `pipeline/pipeline.ts` LangGraph and a `queue/` BullMQ worker — these are
scaffolding for a future automated/server mode. The app and CLI today use the simpler direct
sequence in `service.ts`.)*

---

## 4. The pieces (where everything lives)

```
backend/                     all the logic (one package)
  src/
    service.ts               the high-level API the app calls (scrape, generate, send)
    config.ts                sender/offer/model settings (from env)
    lib/
      browser.ts             launches your Chrome (crawler + a warmed Maps profile)
      groq.ts                Groq AI client + retry logic
      paths.ts               where data is stored (DATA_DIR)
      csv-leads.ts           parses the lead CSV
    scrapers/
      gmaps-search.ts        search query → list of businesses
      gmaps-reviews.ts       a place → details + top/worst reviews   ← review selectors live here
      crawler.ts             website → clean text
    agents/                  researcher, reviews-analyst, writer (+ scheduler stub)
    storage/                 saves runs to disk (swappable to a database later)
    mailer.ts                sends email over SMTP (nodemailer)

desktop/                     the clickable app (Electron)
  main.js                    app window + settings + bridge to the backend
  preload.js                 safe bridge between the UI and main
  renderer/                  the UI (index.html, styles.css, renderer.js)
  assets/icon.png            the mailbox logo
  build.mjs / pack.mjs       packaging scripts (bundle backend + build the .exe folder)

frontend/                    parked early web skeleton (not used)
```

---

## 5. The desktop app

- It's an **Electron** app: a Chromium window (the UI) talking to a Node process (the backend).
- For packaging, the whole backend is **bundled into one file** (`desktop/backend.cjs`) so it
  doesn't depend on the dev `node_modules` layout.
- The packaged app lives at **`F:\OutboundOS-app\OutboundOS-win32-x64\OutboundOS.exe`** with a
  **Desktop shortcut**. It's portable — everything it needs is in that folder.
- **Settings** (Groq key, your name/offer, mailboxes) are saved per-user (in Windows AppData),
  not in the app folder.
- **Data** (scraped leads, generated emails, the warmed Chrome profile) is saved to
  **`F:\OutboundOS\`**.

---

## 6. Key decisions (and why)

- **Uses your installed Chrome** (not a bundled browser): Google serves reviews to a real,
  "warmed" Chrome profile but hides them from automated/headless browsers. Driving real Chrome
  is what makes free review-scraping actually work — and it means nothing extra to install.
- **The Maps window appears briefly while scraping** — that's required; headless gets blocked.
- **Groq is the only paid piece** — crawling/reviews are done in-house.
- **Storage is behind an interface** (`storage/`) — today it's JSON files; switching to a real
  database later is a one-file change, nothing else has to move.
- **Approve-before-send** — nothing goes out until you OK it; sending is throttled to protect
  your inbox reputation.
