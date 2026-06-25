// CRUD campaigns.
import { NextResponse } from "next/server";
import { prisma } from "@outboundos/db";

export async function GET() {
  const campaigns = await prisma.campaign.findMany({ orderBy: { createdAt: "desc" } });
  return NextResponse.json(campaigns);
}

export async function POST(req: Request) {
  const { name } = (await req.json()) as { name?: string };
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const campaign = await prisma.campaign.create({ data: { name } });
  return NextResponse.json(campaign, { status: 201 });
}
