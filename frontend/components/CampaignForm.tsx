// Create-campaign form. TODO: wire submit to POST /api/campaigns.
"use client";

import { useState } from "react";

export function CampaignForm({ onCreated }: { onCreated?: () => void }) {
  const [name, setName] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await fetch("/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setName("");
    onCreated?.();
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Campaign name"
        className="rounded border px-3 py-1.5 text-sm"
      />
      <button className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700">Create</button>
    </form>
  );
}
