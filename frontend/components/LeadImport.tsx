// CSV upload -> POST /api/leads (multipart). Reports imported/skipped counts.
"use client";

import { useState } from "react";

interface ImportResult {
  imported: number;
  skipped: number;
  mappedHeaders?: Record<string, string>;
}

export function LeadImport({ campaignId }: { campaignId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);

    const body = new FormData();
    body.append("file", file);
    body.append("campaignId", campaignId);

    const res = await fetch("/api/leads", { method: "POST", body });
    const json = await res.json();
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? "Upload failed");
      return;
    }
    setResult(json);
  }

  return (
    <form onSubmit={handleUpload} className="space-y-3 rounded-lg border bg-white p-4">
      <p className="text-sm font-medium">Import leads from CSV</p>
      <p className="text-xs text-gray-500">
        Expects the verified lead export format (no header row, fixed column order). Rows missing company, name, or
        email are skipped and reported.
      </p>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block text-sm"
      />
      <button
        disabled={!file || busy}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {busy ? "Importing…" : "Import"}
      </button>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {result && (
        <p className="text-sm text-green-700">
          Imported {result.imported}, skipped {result.skipped}.
        </p>
      )}
    </form>
  );
}
