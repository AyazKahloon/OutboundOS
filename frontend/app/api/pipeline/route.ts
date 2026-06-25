// Trigger the agent pipeline for leads (enqueues BullMQ jobs handled by apps/workers).
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  // TODO: read { campaignId } or { leadIds }, enqueue each lead onto the pipeline queue.
  // Note: importing the workers' enqueueLead here couples web -> workers; consider a thin
  // shared queue client or an internal HTTP call instead.
  return NextResponse.json({ error: "not implemented" }, { status: 501 });
}
