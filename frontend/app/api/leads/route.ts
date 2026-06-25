// Manage leads + CSV import (leads are uploaded, not sourced from an API).
//
// The verified lead CSV has NO header row and uses a fixed column order:
//   0 companyName | 1 companySize | 2 count | 3 fullName | 4 title | 5 roleCategory |
//   6 email | 7 phone | 8 personal LinkedIn | 9 company LinkedIn | 10 phone(dict) |
//   11 location | 12 domain | 13 source | 14-16 flags
import { NextResponse } from "next/server";
import Papa from "papaparse";
import { prisma } from "@outboundos/db";

export async function GET(req: Request) {
  const campaignId = new URL(req.url).searchParams.get("campaignId") ?? undefined;
  const leads = await prisma.lead.findMany({
    where: campaignId ? { campaignId } : undefined,
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(leads);
}

const COL = {
  companyName: 0,
  fullName: 3,
  title: 4,
  email: 6,
  phone: 7,
  personalLinkedin: 8,
  companyLinkedin: 9,
  location: 11,
  domain: 12,
} as const;

const clean = (v: string | undefined) => v?.trim() || undefined;

// Turn a bare domain into a URL the researcher can scrape.
function toWebsite(domain?: string): string | undefined {
  if (!domain) return undefined;
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

// POST: multipart form with `file` (CSV) and `campaignId`. Inserts leads, skips rows missing required fields.
export async function POST(req: Request) {
  const form = await req.formData();
  const file = form.get("file");
  const campaignId = form.get("campaignId");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file (CSV) is required" }, { status: 400 });
  }
  if (typeof campaignId !== "string" || !campaignId) {
    return NextResponse.json({ error: "campaignId is required" }, { status: 400 });
  }

  const text = await file.text();
  // header: false -> rows are string[] keyed by column index.
  const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: true });
  if (parsed.errors.length) {
    return NextResponse.json({ error: "CSV parse error", details: parsed.errors.slice(0, 5) }, { status: 400 });
  }

  const skipped: { row: number; reason: string }[] = [];
  const rows: {
    campaignId: string;
    fullName: string;
    email: string;
    title?: string;
    phone?: string;
    companyName: string;
    companyWebsite?: string;
    linkedinUrl?: string;
    companyLinkedinUrl?: string;
    location?: string;
  }[] = [];

  parsed.data.forEach((cols, i) => {
    const companyName = clean(cols[COL.companyName]);
    const fullName = clean(cols[COL.fullName]);
    const email = clean(cols[COL.email]);

    // Required: companyName, fullName, email.
    if (!companyName || !fullName || !email) {
      skipped.push({ row: i + 1, reason: "missing companyName/fullName/email" });
      return;
    }

    rows.push({
      campaignId,
      fullName,
      email,
      companyName,
      title: clean(cols[COL.title]),
      phone: clean(cols[COL.phone]),
      companyWebsite: toWebsite(clean(cols[COL.domain])),
      linkedinUrl: clean(cols[COL.personalLinkedin]),
      companyLinkedinUrl: clean(cols[COL.companyLinkedin]),
      location: clean(cols[COL.location]),
    });
  });

  const result = rows.length ? await prisma.lead.createMany({ data: rows }) : { count: 0 };

  return NextResponse.json(
    { imported: result.count, skipped: skipped.length, skippedDetail: skipped.slice(0, 20) },
    { status: 201 }
  );
}
