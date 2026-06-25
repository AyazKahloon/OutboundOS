# OutboundOS — Frontend (parked)

This is an early Next.js dashboard skeleton from before the Google-Maps pivot. It is
**parked** — intentionally left out of the pnpm workspace — until it's rebuilt against the
current backend.

When you build the real frontend:
1. Add `"frontend"` back to `pnpm-workspace.yaml`.
2. Have it talk to the backend over **HTTP** (add an API server in `backend/src/`), rather than
   importing the database directly. The old `@outboundos/db` imports in `app/api/*` reflect the
   pre-pivot design and should be replaced with calls to the backend API.
3. The reusable bits worth keeping: `components/` (LeadTable, EmailPreviewCard, etc.) and the
   dashboard page layouts.
