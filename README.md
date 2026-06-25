# OutboundOS

In-house outbound marketing engine. Given a Google Maps search, it scrapes businesses +
their reviews, crawls each website, and writes a personalized cold email — all locally in
our own Chrome. **The only paid dependency is the Groq LLM** (no scraping/search APIs).

## Layout

- **`backend/`** — all the logic: Maps + review + website scrapers, LLM agents, the LangGraph
  pipeline, Prisma schema, and the CLI scripts. See [`backend/README.md`](./backend/README.md).
- **`frontend/`** — parked Next.js dashboard skeleton, to be rebuilt against the backend API
  later. Not in the active workspace yet.

## Getting started

```bash
pnpm install                       # install backend deps (from repo root)
cp .env.example .env               # then fill in GROQ_API_KEY (+ sender/offer)
pnpm --filter @outboundos/backend db:generate   # if using the DB/dashboard path

# Scrape leads + reviews, then generate emails
pnpm --filter @outboundos/backend scrape-leads "law firms in Austin TX" 20
pnpm --filter @outboundos/backend generate-emails leads.json 20
```

Outputs (`leads.json`, `generated_emails.md`) and the warmed Chrome profile (`.maps-profile/`)
are written to the repo root and gitignored.

## Documentation

- **[HOW_IT_WORKS.md](./HOW_IT_WORKS.md)** — plain-English tour of the whole system (the flow, the agents, where everything lives).
- **[DEVELOPMENT.md](./DEVELOPMENT.md)** — how to change things and exactly what commands to run afterward (incl. rebuilding the `.exe`).
- **[backend/README.md](./backend/README.md)** — backend structure + CLI commands.

## Key rule

Do not automate sending until you've manually reviewed the email outputs and they feel
genuinely personal. Sending is intentionally not wired up.
