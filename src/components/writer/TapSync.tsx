"use client";

import { useEffect, useMemo, useState } from "react";
import { useWriter } from "./context";
import { usePlayer } from "./Player";

/** reaction time: a tap lands a little after the line really starts */
const REACTION = 0.12;

/**
 * Tap along: while the song plays, tap each time a line starts. Every tap
 * saves that line's start on the beat (audio_at); the lines in between are
 * spread by their length, so a few taps per section already keep the
 * highlight in sync.
 */
export function TapSync({ onClose }: { onClose: () => void }) {
  const w = useWriter();
  const p = usePlayer();
  const pid = w.tree.project.id;

  // every lyric line on the beat, in song order
  const order = useMemo(
    () =>
      w.tree.sections.flatMap((s) =>
        s.lines
          .map((l, index) => ({ sectionId: s.id, section: s.name, index, id: l.id, text: l.text, kind: l.kind, at: l.audio_at }))
          .filter((x) => x.kind === "lyric" && x.text.trim() && p.lineStart(x.sectionId, x.index) !== null),
      ),
    [w.tree.sections, p],
  );
  // start at the next line to come from the playhead
  const [cursor, setCursor] = useState(() => {
    const now = p.now();
    const k = order.findIndex((x) => (p.lineStart(x.sectionId, x.index) ?? 0) >= now - 0.3);
    return k < 0 ? 0 : k;
  });
  const cur = order[Math.min(cursor, order.length - 1)];
  const [tapped, setTapped] = useState(0);

  const tap = () => {
    if (!cur) return;
    const at = Math.max(0, p.now() - (p.playing ? REACTION : 0));
    void w.mutate(`/api/projects/${pid}`, { action: "lineTimes", times: [{ id: cur.id, at }] });
    setTapped((n) => n + 1);
    setCursor((c) => Math.min(order.length - 1, c + 1));
  };
  const resetSection = () => {
    if (!cur) return;
    const sec = w.tree.sections.find((s) => s.id === cur.sectionId);
    if (!sec || !window.confirm(`Forget the synced times of “${sec.name}”? Its lines go back to estimated timing.`)) return;
    void w.mutate(`/api/projects/${pid}`, { action: "lineTimes", times: sec.lines.map((l) => ({ id: l.id, at: null })) });
  };

  // keyboard: Enter or T taps (when not typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (e.key === "Enter" || e.key === "t" || e.key === "T") {
        e.preventDefault();
        tap();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!cur)
    return (
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs">
        <span className="flex-1 text-muted">Anchor sections on the beat (⚓) and write some lines first.</span>
        <button className="btn-ghost px-1" onClick={onClose}>
          ✕
        </button>
      </div>
    );

  return (
    <div className="mb-2 rounded-lg border border-accent/40 bg-accent-soft px-2 py-2 text-xs">
      <div className="flex items-center gap-2">
        <button className="btn-ghost px-1.5" disabled={cursor === 0} onClick={() => setCursor((c) => Math.max(0, c - 1))} title="Previous line">
          ‹
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-accent">
            {p.playing ? "Tap when this line starts" : "Press ▶, then tap when this line starts"} · {cur.section}
            {cur.at !== null ? " · synced" : ""}
          </div>
          <div className="truncate text-sm">{cur.text}</div>
        </div>
        <button className="btn-ghost px-1.5" disabled={cursor >= order.length - 1} onClick={() => setCursor((c) => Math.min(order.length - 1, c + 1))} title="Next line">
          ›
        </button>
        <button
          className="btn-primary min-h-11 min-w-20 justify-center text-sm"
          onClick={tap}
          // react on touch-down: no click delay on phones
          onTouchStart={(e) => {
            e.preventDefault();
            tap();
          }}
        >
          TAP
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
        <span className="flex-1">
          {tapped ? `${tapped} tapped · ` : ""}a few taps per section are enough — the lines in between follow their length. Keys: Enter / T
        </span>
        <button className="btn-ghost px-1 text-[11px]" onClick={resetSection}>
          Reset section
        </button>
        <button className="btn-ghost px-1 text-[11px]" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
