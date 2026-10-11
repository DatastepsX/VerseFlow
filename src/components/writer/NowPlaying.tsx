"use client";

import { useWriter } from "./context";
import { usePlayer } from "./Player";

/** where the song is: section, current line and the next one (sticky on top of a panel) */
export function NowPlaying() {
  const w = useWriter();
  const p = usePlayer();
  if (!p.hasAudio || !p.position) return null;
  const s = w.tree.sections.find((x) => x.id === p.position!.sectionId);
  if (!s) return null;
  const k = p.position.lineIndex;
  const line = k !== null ? s.lines[k] : undefined;
  const next = k !== null ? s.lines.slice(k + 1).find((l) => l.kind === "lyric" && l.text.trim()) : undefined;
  const now =
    k === null ? "instrumental" : k >= s.lines.length ? "next bar to write" : line?.text.trim() ? line.text : "(empty bar)";
  return (
    <div className="sticky -top-4 z-10 -mx-4 mb-3 border-b border-line bg-panel/95 px-4 py-2 backdrop-blur">
      <div className="flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-wide text-accent">
        <span>{p.playing ? "♪" : "❚❚"}</span>
        <span className="truncate">{s.name}</span>
      </div>
      <div className={`truncate text-sm ${line?.text.trim() ? "" : "italic text-muted"}`}>{now}</div>
      {next && <div className="truncate text-xs text-muted">next: {next.text}</div>}
    </div>
  );
}
