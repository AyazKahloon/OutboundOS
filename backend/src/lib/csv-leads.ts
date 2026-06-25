// Shared parser for a Google-Maps / Apify lead CSV. Columns are matched by keyword so it
// works regardless of exact header naming. Used by both the CLI and the desktop app.
import Papa from "papaparse";

export interface ManualLead {
  name: string;
  address: string;
  website: string;
  email: string; // decision-maker email (e.g. from Apify)
  contactName: string;
}

const clean = (v: string | undefined) => v?.trim() || "";
const toWebsite = (d: string) => (!d ? "" : /^https?:\/\//i.test(d) ? d : `https://${d}`);

function findCol(headers: string[], candidates: string[]): string | null {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const cand of candidates) {
    const i = lower.findIndex((h) => h === cand || h.includes(cand));
    if (i !== -1) return headers[i]!;
  }
  return null;
}

export interface ParsedCsv {
  leads: ManualLead[];
  columns: Record<string, string | null>;
}

export function parseLeadCsv(text: string): ParsedCsv {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? [];

  const nameCol = findCol(headers, ["name", "business", "company", "title"]);
  const addrCol = findCol(headers, ["full_address", "address", "location", "street"]);
  const siteCol = findCol(headers, ["website", "site", "url", "domain", "web"]);
  const emailCol = findCol(headers, ["email", "e-mail", "mail"]);
  const contactCol = findCol(headers, ["contact", "owner", "person", "manager", "decision"]);

  if (!nameCol) {
    throw new Error(`Could not find a business-name column. Headers seen: ${headers.join(", ") || "(none)"}`);
  }

  const leads = parsed.data
    .map((row) => ({
      name: clean(nameCol ? row[nameCol] : ""),
      address: clean(addrCol ? row[addrCol] : ""),
      website: toWebsite(clean(siteCol ? row[siteCol] : "")),
      email: clean(emailCol ? row[emailCol] : ""),
      contactName: clean(contactCol ? row[contactCol] : ""),
    }))
    .filter((l) => l.name);

  return {
    leads,
    columns: { name: nameCol, address: addrCol, website: siteCol, email: emailCol, contact: contactCol },
  };
}
