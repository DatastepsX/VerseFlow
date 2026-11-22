"use client";

import { useState } from "react";
import { Check, Play } from "@/components/icons";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * A part written by hand, placed on the beat: slide where it starts (on a bar line), choose one or two bars per
 * line, see where its lines land among the other parts, hear it from there — then place it.
 */
export function PlaceSheet({
  name,
  lines,
  duration,
  bar,
  origin,
  initialStart,
  initialStep,
  others,
  onHear,
  onStop,
  playing,
  onPlace,
  onClose,
}: {
  name: string;
  lines: string[];
  duration: number;
  /** a bar (s); null: no tempo — then seconds */
  bar: number | null;
  /** bar 1's time */
  origin: number;
  initialStart: number | null;
  /** seconds per line as placed before (null: one bar) */
  initialStep: number | null;
  /** the song's other placed parts: where they are */
  others: { name: string; start: number; end: number }[];
  onHear: (from: number, until: number) => void;
  onStop: () => void;
  playing: boolean;
  onPlace: (start: number, step: number) => Promise<void>;
  onClose: () => void;
}) {
  const unit = bar ?? 1;
  const toK = (t: number) => Math.max(0, Math.round((t - (bar ? origin : 0)) / unit));
  const at = (k: number) => (bar ? origin : 0) + k * unit;
  const maxK = Math.max(0, Math.floor((duration - (bar ? origin : 0)) / unit) - 1);
  const [k, setK] = useState(() => Math.min(maxK, toK(initialStart ?? (others.length ? Math.max(...others.map((o) => o.end)) : 0))));
  const [per, setPer] = useState<1 | 2>(() => (bar && initialStep && Math.round(initialStep / bar) === 2 ? 2 : 1));
  const [busy, setBusy] = useState(false);
  const start = at(k);
  const step = bar ? per * bar : 4 * per;
  const end = Math.min(duration, start + lines.length * step);
  const fits = start + lines.length * step <= duration + 0.01;
  const clash = others.find((o) => start < o.end - 0.05 && end > o.start + 0.05);
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={() => !busy && onClose()}>
      <div onClick={(e) => e.stopPropagation()} className="max-h-[92dvh] w-full max-w-lg space-y-4 overflow-auto rounded-t-3xl bg-panel px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <div>
          <h2 className="text-xl font-bold">Place “{name}” on the beat</h2>
          <p className="text-xs text-muted">Slide to where it starts — its {lines.length} lines follow, {per === 1 ? "one per bar" : "one every two bars"}.</p>
        </div>

        {/* where it starts: the time, the bar */}
        <div className="flex items-end justify-between">
          <p className="text-3xl font-extrabold tabular-nums">{fmt(start)}</p>
          <p className="pb-1 text-sm font-semibold text-muted">
            {bar ? `bar ${k + 1}` : ""} · to {fmt(end)}
          </p>
        </div>

        {/* the song: the other parts, this one, the slider on top */}
        <div className="space-y-1">
          <div className="relative h-9 overflow-hidden rounded-xl bg-panel-2">
            {others.map((o) => (
              <div key={o.name + o.start} className="absolute inset-y-1 rounded-md bg-fg/15 px-1 text-[9px] font-semibold leading-7 text-muted" style={{ left: pct(o.start), width: `calc(${pct(o.end - o.start)} - 2px)` }}>
                <span className="block truncate">{o.name}</span>
              </div>
            ))}
            <div
              className={`absolute inset-y-0.5 rounded-md ${clash ? "bg-warn/50 ring-1 ring-warn" : "bg-accent/45 ring-1 ring-accent"}`}
              style={{ left: pct(start), width: pct(end - start) }}
            />
          </div>
          <input
            type="range"
            className="w-full accent-[var(--color-accent,#7c5cff)]"
            min={0}
            max={maxK}
            step={1}
            value={k}
            onChange={(e) => {
              setK(Number(e.target.value));
              if (playing) onStop();
            }}
            aria-label="Where the part starts"
          />
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>0:00</span>
            <span>{fmt(duration)}</span>
          </div>
        </div>

        {/* fine: a bar (a second) at a time */}
        <div className="flex gap-2">
          {[-4, -1, 1, 4].map((d) => (
            <button key={d} className="btn flex-1 justify-center rounded-xl border-0 bg-panel-2 py-2 text-sm" disabled={k + d < 0 || k + d > maxK} onClick={() => setK(k + d)}>
              {d > 0 ? "+" : "−"}
              {Math.abs(d)} {bar ? (Math.abs(d) === 1 ? "bar" : "bars") : "s"}
            </button>
          ))}
        </div>

        {bar && (
          <div className="flex rounded-full bg-panel-2 p-1" role="radiogroup" aria-label="Bars per line">
            {([1, 2] as const).map((n) => (
              <button key={n} role="radio" aria-checked={per === n} className={`flex-1 rounded-full py-2 text-[13px] font-semibold ${per === n ? "bg-accent text-white" : "text-muted"}`} onClick={() => setPer(n)}>
                {n === 1 ? "1 bar per line" : "2 bars per line"}
              </button>
            ))}
          </div>
        )}

        {/* where its lines land */}
        <div className="space-y-1 rounded-2xl bg-panel-2/70 px-3 py-2.5 text-sm">
          {lines.slice(0, 3).map((l, i) => (
            <p key={i} className="flex gap-2">
              <span className="w-10 shrink-0 font-mono text-[11px] leading-5 text-muted">{fmt(start + i * step)}</span>
              <span className="min-w-0 flex-1 truncate">{l || "…"}</span>
            </p>
          ))}
          {lines.length > 3 && <p className="pl-12 text-[11px] text-muted">… {lines.length - 3} more · the last at {fmt(start + (lines.length - 1) * step)}</p>}
        </div>
        {!fits && <p className="rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn">The song ends before its last lines — they stay without a place. Start earlier, or one bar per line.</p>}
        {clash && <p className="rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn">It overlaps “{clash.name}” — fine for a double, else move it.</p>}

        <div className="flex gap-2">
          <button
            className="btn flex-1 justify-center rounded-2xl border-0 bg-panel-2 py-3 text-sm"
            onClick={() => (playing ? onStop() : onHear(Math.max(0, start - (bar ?? 2)), Math.min(duration, start + Math.min(4, lines.length) * step + 0.5)))}
          >
            <Play className="h-4 w-4" /> {playing ? "Stop" : "Hear from here"}
          </button>
          <button
            className="btn-primary flex-[1.3] justify-center rounded-2xl py-3 text-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                onStop();
                await onPlace(start, step);
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            <Check className="h-4 w-4" /> {busy ? "Placing…" : `Place it at ${fmt(start)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
