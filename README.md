# OutboundOS

**A self-hosted outbound engine that turns a list of local businesses into personalized cold emails — automatically.**

Point it at a Google Maps search (or a CSV of businesses) and OutboundOS will, for each one: crawl the website, read the Google reviews, and write a genuinely personal cold email — a real compliment, a problem quietly costing them time and money, and how you can help. You review, approve, and send from the built-in desktop app.

> **The only paid dependency is the Groq LLM.** Every bit of scraping and crawling runs locally in your own Google Chrome — no scraping APIs, no search APIs, no per-business cost.

---

## Table of contents

- [Why it exists](#why-it-exists)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Using the CLI](#using-the-cli)
- [Using the desktop app](#using-the-desktop-app)
- [Project structure](#project-structure)
- [Design decisions & caveats](#design-decisions--caveats)
- [Documentation](#documentation)

---

## Why it exists

Most cold-email tooling either (a) sends generic spray-and-pray templates that get ignored, or (b) charges per-lead for enrichment/scraping APIs that quickly get expensive at volume.

OutboundOS takes a different stance:

- **Personalization is the product.** Every email is grounded in that specific business's website and its real reviews — a genuine compliment from a 5-star review, and a real pain point from a 1-star review.
- **No scraping bills.** Crawling and review-reading are done in-house with a local browser, so the only marginal cost per email is the LLM call.
- **You stay in control.** Nothing sends until you approve it. Sending is throttled to protect your inbox reputation.

---

## What it does

1. **Finds leads** — from a Google Maps search (`"dentists in Austin TX"`) or a CSV export (name, address, website, decision-maker email).
2. **Gathers intelligence** — crawls each business's website for clean text, and reads its Google reviews (a few of the best for praise, a few of the worst for pain points).
3. **Writes the email** — an AI agent produces a subject + body tailored to that business: compliment → a problem costing them time/money → how you help → a soft question. It's prompted to sound like a real person typing in Gmail (no em-dashes, no AI tells, no sales clichés).
4. **Review, approve & send** — drafts are saved as a "run." In the desktop app you approve each one, pick a mailbox, and send. Sent emails are tracked, and automated follow-up sequences can be dispatched when you open the app.

---

## How it works

```
  LEADS IN
  ├─ Search mode:  "dentists in Austin TX"  → finds businesses on Google Maps
  └─ CSV mode:     a file with name, address, website, decision-maker email
        │
        ▼  (for each business, run concurrently)
  GATHER (in-house, your local Chrome — no APIs)
  ├─ Website crawler   → key pages (about/services/team/contact) → clean text
  └─ Reviews scraper   → ~3 top-rated reviews + ~5 worst-rated reviews
        │
        ▼
  WRITE (Groq LLM)
  └─ Composer agent : website text + best/worst reviews + your offer
                      → { subject, body }  (one LLM call per business)
        │
        ▼
  SAVE   → a "run" stored on disk as JSON
        │
        ▼
  REVIEW & SEND (desktop app)
  └─ Approve each draft → pick a mailbox → Send → tracked in the "Sent" tab
                                              └→ follow-up sequence scheduled
```

**Why reviews matter twice:** the compliment is drawn from genuine positive reviews (so it's real), and the pitch is drawn from genuine complaints (so it's relevant). The two never get invented from each other.

**Graceful degradation:** no website → work from reviews only; no reviews → work from the site only; a malformed AI response → it retries automatically. Leads with no contact email are skipped before the LLM is even called (saving tokens), since they aren't sendable.

> The repo also contains a 3-agent pipeline (`researcher` → `reviews-analyst` → `writer`) wired through a LangGraph graph and a BullMQ queue. That's scaffolding for a future automated/server mode. The app and CLI today use the simpler, cheaper **single composer agent** in `service.ts` (one LLM call instead of three).

---

## Architecture

OutboundOS is a pnpm monorepo with three packages:

| Package | What it is |
|---|---|
| **`backend/`** | All the logic — scrapers, the LLM agent(s), storage, the mailer, and the CLI scripts. A self-contained Node/TypeScript package (`@outboundos/backend`). |
| **`desktop/`** | The clickable app — an Electron shell whose UI talks to a bundled copy of the backend. This is the primary way to use OutboundOS day-to-day. |
| **`frontend/`** | A parked Next.js dashboard skeleton, to be rebuilt against a backend HTTP API later. Not in the active workspace. |

The backend exposes one high-level API (`service.ts`) that the desktop app and CLI both call: `scrapeLeads`, `generateEmail(s)`, `scrapeAndGenerate(query, count, onProgress)`. Storage sits behind a `LeadStore` interface (today a `DiskStore` writing one JSON file per run) so a real database can slot in later with a one-line change.

---

## Tech stack

- **Language/runtime:** TypeScript on Node 20+, run with `tsx`.
- **LLM:** [Groq](https://groq.com) (`groq-sdk`) — the only paid dependency. Default model `openai/gpt-oss-120b`, with a shared token-bucket rate limiter that honors `Retry-After`.
- **Scraping/crawling:** [Playwright](https://playwright.dev) driving your **installed Google Chrome** — `@mozilla/readability` + `turndown` to turn pages into clean markdown.
- **Desktop:** [Electron](https://www.electronjs.org), packaged with `@electron/packager`, backend bundled to a single file with `esbuild`.
- **Email:** `nodemailer` (SMTP, any provider) for sending; `imapflow` for reply detection.
- **Optional/scaffolding:** Prisma + Postgres (schema), BullMQ + Redis (queue), LangGraph (pipeline) — for the future server/dashboard path.

---

## Getting started

### Prerequisites

- **Node.js 20+** and **pnpm 9** (`npm install -g pnpm`)
- **Google Chrome** installed (the scrapers drive your real Chrome)
- A **Groq API key** — free tier works ([console.groq.com](https://console.groq.com))

### Install

```bash
git clone <your-repo-url> OutboundOS
cd OutboundOS

pnpm install                 # installs all workspace deps
cp .env.example .env         # then fill in GROQ_API_KEY (+ sender/offer) — see below
```

Then either use the **CLI** (fastest way to try it) or run the **desktop app**.

---

## Configuration

Copy `.env.example` to `.env` and fill in. The only values you truly need to generate emails are the Groq key and your sender details:

```bash
# Required — the only paid dependency
GROQ_API_KEY=your_groq_key_here

# Who the email is from, and what you're offering (used by the writer)
SENDER_NAME=Ayaz
SENDER_COMPANY=KodWorks
OFFER=We build custom software & automation that saves businesses time and money...

# Optional model override (defaults to openai/gpt-oss-120b)
# GROQ_MODEL=openai/gpt-oss-120b
```

The remaining variables (`DATABASE_URL`, `UPSTASH_REDIS_*`, `RESEND_*`, `NEXTAUTH_*`) are only needed for the optional database/queue/dashboard path and can be left blank for normal use.

In the **desktop app**, all of this — plus your sending mailboxes — is entered in the in-app **Settings** screen instead of `.env`, and stored per-user in Windows AppData.

---

## Using the CLI

Run from the repo root:

```bash
# 1) Scrape businesses + reviews from Google Maps into leads.json
pnpm scrape-leads "law firms in Austin TX" 20

# 2) Generate personalized emails from the scraped leads
pnpm generate-emails leads.json 20
```

This writes `leads.json` and `generated_emails.md` / `.csv` to the repo root (all gitignored). You can also feed `generate-emails` a Google Maps CSV export directly.

```bash
# One-off single-business test (debug)
pnpm dry-run "Joe's Pizza" "https://joespizzanyc.com" "New York, NY"

# Typecheck everything
pnpm lint
```

> A Chrome window will appear briefly while reviews are being scraped — this is required (see [caveats](#design-decisions--caveats)).

---

## Using the desktop app

The desktop app is the full experience: search/upload, review drafts, manage mailboxes, send, and track replies + follow-ups.

**Run it in dev:**

```bash
pnpm --filter @outboundos/backend build      # compile the backend first
pnpm --filter @outboundos/desktop start       # launches the Electron window
```

**Build a portable app (Windows):**

```bash
pnpm --filter @outboundos/backend build
pnpm --filter @outboundos/desktop run make     # bundles backend + packages the .exe folder
```

This produces a portable, self-contained app folder (no installer, no signing) plus a desktop shortcut. On first run, open **Settings** and enter your Groq key, name/offer, and one or more sending mailboxes (Gmail / Outlook presets, or custom SMTP).

The app workflow: **Run** (search or upload CSV) → **Results** (approve drafts, pick a mailbox, send) → **Sent** (per-mailbox history) → automated follow-ups dispatch when you open the app and click "Send due follow-ups."

---

## Project structure

```
OutboundOS/
├─ backend/                      all the logic (@outboundos/backend)
│  ├─ prisma/schema.prisma       Postgres schema (optional dashboard path)
│  └─ src/
│     ├─ service.ts              high-level API the app/CLI call (scrape, generate, send)
│     ├─ config.ts               sender / offer / model config (from env or settings)
│     ├─ lib/
│     │  ├─ browser.ts           launches your Chrome (crawler + warmed Maps profile)
│     │  ├─ groq.ts              Groq client + rate limiter + retry/backoff
│     │  ├─ paths.ts             where data is stored (DATA_DIR)
│     │  └─ csv-leads.ts         parses the lead CSV
│     ├─ scrapers/               in-house, no API
│     │  ├─ gmaps-search.ts      search query → list of businesses
│     │  ├─ gmaps-reviews.ts     a place → details + top/worst reviews  ← selectors live here
│     │  └─ crawler.ts           website → clean text (+ harvests a contact email)
│     ├─ agents/                 composer (used) + researcher/analyst/writer/followup
│     ├─ storage/                saves runs to disk (swappable to a database later)
│     ├─ mailer.ts               sends email over SMTP + checks replies over IMAP
│     ├─ pipeline/ + queue/      LangGraph + BullMQ scaffolding (future server mode)
│     └─ scripts/                scrape-leads, generate-emails, dry-run
│
├─ desktop/                      the clickable app (Electron)
│  ├─ main.js                    app window + settings + bridge to the backend
│  ├─ preload.js                 safe bridge between the UI and main
│  ├─ renderer/                  the UI (index.html, styles.css, renderer.js)
│  ├─ build.mjs / pack.mjs       bundle the backend + package the .exe folder
│  └─ assets/                    app icon
│
└─ frontend/                     parked Next.js skeleton (not used yet)
```

---

## Design decisions & caveats

- **Uses your installed Chrome, not a bundled browser.** Google serves reviews to a real, "warmed" Chrome profile but hides them from automated/headless browsers. Driving real Chrome is what makes free review-scraping actually work — and means there's nothing extra to install.
- **A Chrome window appears briefly while scraping reviews.** This is required; running headless gets the reviews-suppressed layout (0 reviews).
- **Groq is the only paid piece.** Crawling and reviews are fully in-house.
- **Approve-before-send.** Nothing goes out until you OK it, and sending is throttled (~8–15s between emails) to protect inbox reputation.
- **Storage is behind an interface.** Today it's JSON files on disk; switching to a real database later is a one-file change.
- **Emails never mention the reviews.** Reviews are private intelligence used to ground the email; the email speaks in your voice about the business's good work and the gaps you noticed — it never says "I read your reviews."
- **Deliverability is on you.** Use a dedicated sending domain with SPF/DKIM/DMARC, warm it up, and keep volume sane (~30–50/day per inbox).
- **Sending needs a recipient email.** CSV-mode leads carry the decision-maker email; pure Maps-search leads only become sendable when the crawler can harvest an email from the site.

---

## Documentation

- **[HOW_IT_WORKS.md](./HOW_IT_WORKS.md)** — plain-English tour of the whole system.
- **[DEVELOPMENT.md](./DEVELOPMENT.md)** — how to change things and exactly what to run afterward (including rebuilding the `.exe`).
- **[backend/README.md](./backend/README.md)** — backend structure + CLI command reference.

---

## License

Private / proprietary. All rights reserved unless a license file says otherwise.
