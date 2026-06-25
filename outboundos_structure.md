# OutboundOS — Project Structure & Tech Stack

## Stack at a Glance

| Layer | Tool | Free Tier |
|---|---|---|
| Frontend | Next.js 14 + Tailwind + shadcn/ui | Free |
| Database | Neon (Postgres) + Prisma | Free |
| Cache / Queue | Upstash Redis + BullMQ | Free |
| Agent Framework | LangGraph + LangChain | Free |
| LLM | Groq (Llama 3.3 — researcher + writer) | Free |
| Web Scraping | Firecrawl | Free tier |
| Search | Tavily | Free tier |
| Lead Sourcing | CSV upload (no API) | Free |
| Email Sending | Resend | 3k/mo free |
| Deployment | Railway | Free trial |

---

## Folder Structure

```
outboundos/
│
├── apps/
│   ├── web/                          # Next.js frontend dashboard
│   │   ├── app/
│   │   │   ├── (dashboard)/
│   │   │   │   ├── campaigns/        # Campaign list + create
│   │   │   │   ├── leads/            # Lead table, import CSV
│   │   │   │   ├── review/           # Human approval queue
│   │   │   │   └── analytics/        # Sent / opened / replied
│   │   │   ├── api/
│   │   │   │   ├── campaigns/        # CRUD campaigns
│   │   │   │   ├── leads/            # Import + manage leads
│   │   │   │   ├── pipeline/         # Trigger agent pipeline
│   │   │   │   └── webhooks/         # Resend email events
│   │   │   └── layout.tsx
│   │   └── components/
│   │       ├── ui/                   # shadcn components
│   │       ├── LeadTable.tsx
│   │       ├── EmailPreviewCard.tsx  # Shows draft + approve button
│   │       └── CampaignForm.tsx
│   │
│   └── workers/                      # Background agent workers (Node.js)
│       ├── src/
│       │   ├── agents/
│       │   │   ├── researcher.agent.ts   # Agent 1: research company
│       │   │   ├── writer.agent.ts       # Agent 2: write email
│       │   │   └── scheduler.agent.ts    # Agent 3: send via Resend
│       │   ├── graph/
│       │   │   └── pipeline.graph.ts     # LangGraph state machine
│       │   ├── tools/
│       │   │   ├── tavily.tool.ts        # Tavily search wrapper
│       │   │   └── firecrawl.tool.ts     # Firecrawl scrape wrapper
│       │   ├── queues/
│       │   │   ├── pipeline.queue.ts     # BullMQ queue definition
│       │   │   └── pipeline.worker.ts    # BullMQ worker processor
│       │   └── index.ts                  # Worker entry point
│       └── package.json
│
├── packages/
│   └── db/                           # Shared Prisma schema
│       ├── prisma/
│       │   └── schema.prisma
│       └── index.ts                  # Export Prisma client
│
├── .env                              # All API keys here
├── package.json                      # Monorepo root (turborepo or pnpm workspaces)
└── README.md
```

---

## Prisma Schema

```prisma
model Campaign {
  id          String   @id @default(cuid())
  name        String
  status      String   @default("draft") // draft | running | paused | done
  createdAt   DateTime @default(now())
  leads       Lead[]
}

model Lead {
  id               String    @id @default(cuid())
  campaignId       String
  campaign         Campaign  @relation(fields: [campaignId], references: [id])

  // Raw data (from CSV upload)
  fullName           String
  email              String
  title              String?
  phone              String?
  companyName        String
  companyWebsite     String?
  linkedinUrl        String?   // personal LinkedIn
  companyLinkedinUrl String?
  location           String?

  // Agent outputs
  researchJson     Json?     // Agent 2 output
  emailDraft       String?   // Agent 3 output
  emailSubject     String?

  // Status
  status           String    @default("pending")
  // pending | researching | draft_ready | approved | sent | opened | replied

  approvedAt       DateTime?
  sentAt           DateTime?
  createdAt        DateTime  @default(now())
}
```

---

## LangGraph Pipeline (concept)

```typescript
// graph/pipeline.graph.ts

import { StateGraph } from "@langchain/langgraph"

// State that flows between all agents
interface PipelineState {
  leadId: string
  companyName: string
  companyWebsite: string
  linkedinUrl: string
  decisionMakerName: string

  // Populated by researcher
  researchJson: {
    whatTheyDo: string
    recentNews: string
    decisionMakerInterests: string
    visiblePainPoints: string[]
    personalizationHooks: string[]
  } | null

  // Populated by writer
  emailSubject: string | null
  emailDraft: string | null

  error: string | null
}

const graph = new StateGraph<PipelineState>({...})

graph
  .addNode("researcher", researcherAgent)
  .addNode("writer",     writerAgent)
  .addNode("save",       saveToDb)
  .addEdge("__start__",  "researcher")
  .addEdge("researcher", "writer")
  .addEdge("writer",     "save")
  .addEdge("save",       "__end__")

export const pipeline = graph.compile()
```

---

## Lead Intake

Leads are uploaded as a CSV via the dashboard (`POST /api/leads`, multipart with `file` + `campaignId`).
The verified export has **no header row** and a fixed column order:

```
0 companyName | 1 companySize | 2 count | 3 fullName | 4 title | 5 roleCategory |
6 email | 7 phone | 8 personalLinkedIn | 9 companyLinkedIn | 10 phone(dict) |
11 location | 12 domain | 13 source | 14-16 flags
```

Imported into `Lead`: companyName, fullName, title, phone, email, linkedinUrl (personal),
companyLinkedinUrl, location, and companyWebsite (derived from the domain).
Required: `companyName`, `fullName`, `email` — rows missing any are skipped and reported.

---

## Agent Responsibilities

### researcher.agent.ts
- Takes: `companyWebsite`, `linkedinUrl`, `decisionMakerName`
- Calls: Firecrawl (scrape website) + Tavily (2 searches)
- Calls: Groq Llama 3.3 to extract structured JSON from raw content
- Returns: `researchJson`

### writer.agent.ts
- Takes: `researchJson` + lead name + your offer
- Calls: Groq Llama 3.3 with a strict prompt (JSON mode)
- Returns: `emailSubject` + `emailDraft`

### scheduler.agent.ts (runs after human approval)
- Takes: approved `emailDraft` + `email`
- Calls: Resend API
- Updates: lead status to `sent`

---

## Environment Variables

```env
# LLMs
GROQ_API_KEY=
GEMINI_API_KEY=

# Scraping + Search
FIRECRAWL_API_KEY=
TAVILY_API_KEY=

# Leads come from CSV upload — no lead-sourcing API keys needed.

# Database
DATABASE_URL=         # Neon Postgres

# Queue
UPSTASH_REDIS_URL=
UPSTASH_REDIS_TOKEN=

# Email
RESEND_API_KEY=
RESEND_FROM_EMAIL=

# App
NEXTAUTH_SECRET=
NEXTAUTH_URL=
```

---

## How to Start Building (order matters)

1. `packages/db` — set up Prisma schema + Neon connection first, everything depends on this
2. `apps/workers/queues` — set up BullMQ + Upstash, test a dummy job
3. `apps/workers/tools` — wrap Firecrawl + Tavily, test each independently
4. `apps/workers/agents/researcher.agent.ts` — build + test on 5 real leads manually
5. `apps/workers/agents/writer.agent.ts` — build + test, read every output
6. `apps/workers/graph/pipeline.graph.ts` — wire them together in LangGraph
7. `apps/web` — build dashboard last, once the pipeline actually works

---

## Key Rule

**Do not automate sending until you've manually reviewed 20+ email outputs and 8/10 feel genuinely personal.** The review queue in the dashboard exists for this reason — always approve before send.
