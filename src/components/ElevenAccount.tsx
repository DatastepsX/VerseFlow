"use client";

import { useState } from "react";
import { ChevronRight } from "@/components/icons";

/** the ElevenLabs account the app uses (lyrics reading, your voice, vocal removal): shown on request */
export function ElevenAccount() {
  type Info = {
    connected: boolean;
    error?: string;
    name?: string | null;
    email?: string | null;
    userId?: string | null;
    plan?: string | null;
    status?: string | null;
    billing?: string | null;
    used?: number | null;
    limit?: number | null;
    resets?: number | null;
    voiceCloning?: boolean | null;
    voices?: { used: number | null; limit: number | null };
    nextInvoice?: { cents: number | null; at: number | null; currency: string | null } | null;
    app?: { songsRead: number; minutesHeard: number; linesSpoken: number; charactersSpoken: number; vocalsRemoved: number; takesSynced?: number; voicesMade: number };
  };
  const [info, setInfo] = useState<Info | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setInfo((await fetch("/api/voice?account").then((r) => r.json())) as Info);
    } finally {
      setLoading(false);
    }
  };
  const row = "flex w-full items-center gap-3 rounded-2xl bg-panel px-4 py-3 text-left ring-1 ring-line/60";
  const date = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toLocaleDateString() : "");
  const n = (v: number | null | undefined) => (v ?? 0).toLocaleString();
  const share = info?.limit ? Math.min(1, (info.used ?? 0) / info.limit) : 0;
  return (
    <div className="space-y-2">
      <p className="label">ElevenLabs account</p>
      {!info ? (
        <button className={row} disabled={loading} onClick={() => void load()}>
          <span className="flex-1 text-sm">{loading ? "Asking ElevenLabs…" : "Show the account the app uses"}</span>
          <ChevronRight className="h-4 w-4 text-muted" />
        </button>
      ) : !info.connected ? (
        <p className="rounded-2xl bg-panel px-4 py-3 text-sm ring-1 ring-line/60">No ElevenLabs key is set up.</p>
      ) : info.error ? (
        <p className="rounded-2xl bg-warn-soft px-4 py-3 text-sm text-warn">{info.error}</p>
      ) : (
        <div className="space-y-3 rounded-2xl bg-panel px-4 py-3 text-sm ring-1 ring-line/60">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">
              <b>{info.email || info.name || "Account"}</b>
              {info.email && info.name ? ` · ${info.name}` : ""}
              {info.userId ? <span className="text-muted"> · id {info.userId}</span> : null}
            </span>
            {info.plan && <span className="shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-semibold capitalize text-accent">{info.plan.replace(/_/g, " ")}</span>}
          </div>
          {info.limit ? (
            <div>
              <div className="flex justify-between text-xs">
                <span>
                  <b>{n(info.used)}</b> of {n(info.limit)} credits used
                </span>
                <span className="text-muted">{n(Math.max(0, info.limit - (info.used ?? 0)))} left</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-panel-2">
                <div className={`h-full rounded-full ${share > 0.9 ? "bg-bad" : share > 0.7 ? "bg-warn" : "bg-accent"}`} style={{ width: `${share * 100}%` }} />
              </div>
              {info.resets ? <p className="mt-1 text-xs text-muted">New credits on {date(info.resets)}</p> : null}
            </div>
          ) : null}
          <div className="divide-y divide-line/60">
            {info.status && <Item label="Status" value={<span className="capitalize">{info.status.replace(/_/g, " ")}</span>} />}
            {info.billing && <Item label="Billing" value={<span className="capitalize">{info.billing.replace(/_period$/, "").replace(/_/g, " ")}</span>} />}
            {info.nextInvoice?.cents != null && (
              <Item
                label="Next invoice"
                value={`${(info.nextInvoice.cents / 100).toLocaleString(undefined, { style: "currency", currency: (info.nextInvoice.currency ?? "usd").toUpperCase() })}${info.nextInvoice.at ? ` · ${date(info.nextInvoice.at)}` : ""}`}
              />
            )}
            {info.voiceCloning !== null && info.voiceCloning !== undefined && (
              <Item label="Your own voice (cloning)" value={info.voiceCloning ? <span className="text-ok">included</span> : <span className="text-warn">not in this plan</span>} />
            )}
            {info.voices?.limit != null && <Item label="Voice slots" value={`${n(info.voices.used)} of ${n(info.voices.limit)}`} />}
          </div>
          {info.app && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">VerseFlow this period</p>
              <div className="divide-y divide-line/60">
                <Item label="Songs read for lyrics" value={`${info.app.songsRead} · ${info.app.minutesHeard} min heard`} />
                <Item label="Lines in your voice" value={`${info.app.linesSpoken} · ${n(info.app.charactersSpoken)} characters`} />
                <Item label="Vocals removed" value={info.app.vocalsRemoved} />
                <Item label="Takes synced to the lyrics" value={info.app.takesSynced ?? 0} />
                <Item label="Voices created" value={info.app.voicesMade} />
              </div>
            </div>
          )}
          <button className="text-xs font-semibold text-accent" disabled={loading} onClick={() => void load()}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      )}
    </div>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

