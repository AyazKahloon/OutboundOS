// Resend email event webhooks (delivered / opened / replied / bounced).
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  // TODO: verify Resend signature, parse event, update Lead status (opened | replied).
  const event = await req.json();
  console.log("[webhook] resend event", event?.type);
  return NextResponse.json({ received: true });
}
