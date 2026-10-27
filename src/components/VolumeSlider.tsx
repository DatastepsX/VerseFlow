"use client";

import { MIX_MAX, pct } from "@/lib/studio/mix";

/** a volume: 0–150% (or up to `max`) with 100% marked, thumb-sized for a phone; tap the number for 100% */
export function VolumeSlider({ value, onValue, label, max = MIX_MAX }: { value: number; onValue: (v: number) => void; label: string; max?: number }) {
  return (
    <div className="mt-2 flex items-center gap-3">
      <div className="relative flex-1">
        <span className="pointer-events-none absolute top-1/2 h-4 w-px -translate-y-1/2 bg-muted/50" style={{ left: `${(1 / max) * 100}%` }} />
        <input
          type="range"
          min={0}
          max={max}
          step={0.01}
          value={value}
          onChange={(e) => onValue(Number(e.target.value))}
          className="vf-volume relative w-full"
          aria-label={`${label} volume`}
          style={{ ["--fill" as string]: `${(Math.min(value, max) / max) * 100}%` }}
        />
      </div>
      <button className={`w-12 shrink-0 rounded-full py-1 text-right font-mono text-xs tabular-nums ${value === 1 ? "text-muted" : "font-semibold text-accent"}`} onClick={() => onValue(1)} aria-label={`${label} back to 100%`}>
        {pct(value)}
      </button>
    </div>
  );
}
