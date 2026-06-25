# OutboundOS — Backend

Self-contained Node/TypeScript backend. Everything except the LLM (Groq) runs locally —
website crawling and Google Maps/review scraping are done in our own Chrome, so there are
no scraping/search API costs.

## Structure

```
backend/
  prisma/schema.prisma        Postgres schema (Campaign, Lead)
  src/
    index.ts                  worker bootstrap (HTTP API can be added here later)
    config.ts                 sender/offer/model config (from .env)
    db/client.ts              shared Prisma client
    lib/
      env.ts                  loads repo-root .env (import first)
      browser.ts              Playwright browsers: bundled Chromium (crawl) + real Chrome (Maps)
      groq.ts                 Groq client + JSON helper with retry/backoff
    agents/                   LLM agents
      researcher.agent.ts     crawled site  -> structured research
      reviews-analyst.agent.ts reviews      -> praise / complaints / pain points / hooks
      writer.agent.ts         research+reviews -> personalized email
      scheduler.agent.ts      send via Resend (not wired by default)
    scrapers/                 in-house, no API
      crawler.ts              crawl key website pages -> markdown
      gmaps-search.ts         search query -> list of businesses
      gmaps-reviews.ts        place details + balanced review sample (relevant + lowest-rated)
    pipeline/pipeline.ts      LangGraph: crawl -> reviews -> research -> analyze -> write -> save
    queue/                    BullMQ queue + worker (for the dashboard path)
    scripts/
      scrape-leads.ts         search Maps -> leads.json (+ csv)
      generate-emails.ts      leads.json | maps.csv -> generated_emails.md (+ csv)
      dry-run.ts              full pipeline on a single business (debug)
```

## Commands (run from the repo root)

```bash
# 1) Scrape businesses + reviews from Google Maps into leads.json
pnpm --filter @outboundos/backend scrape-leads "law firms in Austin TX" 20

# 2) Generate personalized emails from the scraped leads
pnpm --filter @outboundos/backend generate-emails leads.json 20

# One-off single-business test
pnpm --filter @outboundos/backend dry-run "Joe's Pizza" "https://joespizzanyc.com" "New York, NY"

# Typecheck
pnpm --filter @outboundos/backend lint

# Database (when using the dashboard/queue path)
pnpm --filter @outboundos/backend db:generate
pnpm --filter @outboundos/backend db:push
```

Outputs (`leads.json`, `generated_emails.md`, etc.) and the warmed Chrome profile
(`.maps-profile/`) are written to the repo root and are gitignored.

## Notes
- `SCRAPER_HEADLESS=0` to watch the browser; the Maps scraper runs headed by default for reliability.
- Review-card selectors live in `scrapers/gmaps-reviews.ts` — the one place to update if Google
  changes its DOM. Everything degrades gracefully (rating-only) rather than crashing.
- Connecting a frontend later: add an HTTP API in `src/` (e.g. `src/server.ts`) that calls the
  same scrapers/pipeline, and have the frontend talk to it.
