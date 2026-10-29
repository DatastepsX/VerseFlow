"use client";

import { useState } from "react";

export function JoinButton({ invite, name }: { invite: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const join = async () => {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "join", invite }) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; projectId?: string };
    if (!res.ok || !data.projectId) {
      setError(data.error ?? "Couldn't join the song");
      setBusy(false);
      return;
    }
    window.location.href = `/song/${data.projectId}`;
  };
  return (
    <div className="space-y-2">
      <button className="btn-primary w-full justify-center" disabled={busy} onClick={() => void join()}>
        {busy ? "Joining…" : `Join as ${name}`}
      </button>
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}
