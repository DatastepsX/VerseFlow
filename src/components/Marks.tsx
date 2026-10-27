"use client";

import { useState } from "react";
import { MARK_KINDS, markInfo, wordsOf, type Mark, type MarkKind } from "@/lib/marks";

/**
 * A line with its recording marks: ‖ pause and ˇ breath after a word, 2× and
 * a wavy underline for double-time, ~ stretched, › accented (bold), ↗ ↘ the
 * voice going up / down, ⟲ an echo. `lit`: words already sung (karaoke).
 */
export function MarkedText({ text, marks, lit, onWord }: { text: string; marks: Mark[]; lit?: (word: number) => boolean; onWord?: (word: number) => void }) {
  const words = wordsOf(text);
  const on = (i: number, k: MarkKind) => marks.some((m) => m.kind === k && m.at === i);
  const inDouble = (i: number) => marks.some((m) => m.kind === "double" && i >= m.at && i <= (m.to ?? m.at));
  return (
    <>
      {words.map((w, i) => {
        const after = marks.filter((m) => m.at === i && ["pause", "rest", "breath", "up", "down", "echo"].includes(m.kind));
        return (
          <span key={i}>
            {i > 0 && " "}
            {marks.some((m) => m.kind === "double" && m.at === i) && (
              <span className="mr-0.5 rounded bg-accent px-1 align-[0.15em] text-[0.55em] font-bold text-white">2×</span>
            )}
            {on(i, "accent") && <span className="text-[0.8em] font-bold text-accent">›</span>}
            <span
              onClick={onWord && (() => onWord(i))}
              role={onWord ? "button" : undefined}
              className={`${onWord ? "cursor-pointer rounded active:bg-accent-soft" : ""} ${inDouble(i) ? "underline decoration-accent decoration-wavy decoration-2 underline-offset-4" : ""} ${on(i, "accent") ? "font-extrabold" : ""} ${lit?.(i) ? "text-accent" : ""}`}
            >
              {w}
            </span>
            {on(i, "stretch") && <span className="font-bold text-accent">~</span>}
            {after.map((m) => (
              <span
                key={m.kind}
                className={`font-bold text-accent ${m.kind === "pause" || m.kind === "rest" || m.kind === "breath" ? "mx-0.5" : "ml-0.5 align-super text-[0.65em]"}`}
                title={markInfo(m.kind).label}
              >
                {markInfo(m.kind).symbol}
              </span>
            ))}
          </span>
        );
      })}
    </>
  );
}

/** pick a mark, tap the words: a mark on a word comes off with a second tap; double-time = first word, then last */
export function MarksEditor({ text, marks, onSave, onCancel }: { text: string; marks: Mark[]; onSave: (m: Mark[]) => void; onCancel: () => void }) {
  const words = wordsOf(text);
  const [items, setItems] = useState<Mark[]>(marks);
  const [tool, setTool] = useState<MarkKind>("pause");
  const [from, setFrom] = useState<number | null>(null);
  const tap = (i: number) => {
    if (tool === "double") {
      // inside a double-time stretch: it comes off
      const hit = items.find((m) => m.kind === "double" && i >= m.at && i <= (m.to ?? m.at));
      if (hit && from === null) return setItems(items.filter((m) => m !== hit));
      if (from === null) return setFrom(i);
      const [a, b] = [Math.min(from, i), Math.max(from, i)];
      setItems([...items.filter((m) => !(m.kind === "double" && m.at <= b && (m.to ?? m.at) >= a)), { kind: "double", at: a, to: b }]);
      return setFrom(null);
    }
    const has = items.some((m) => m.kind === tool && m.at === i);
    setItems(has ? items.filter((m) => !(m.kind === tool && m.at === i)) : [...items, { kind: tool, at: i }]);
  };
  const info = markInfo(tool);
  return (
    <div className="mt-2 space-y-2.5 rounded-2xl bg-panel-2/70 p-3">
      <div className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
        {MARK_KINDS.map((k) => (
          <button
            key={k.kind}
            className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-semibold ${tool === k.kind ? "bg-accent text-white" : "bg-panel text-fg/80"}`}
            onClick={() => {
              setTool(k.kind);
              setFrom(null);
            }}
          >
            <span className="font-bold">{k.symbol}</span> {k.label}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted">
        {tool === "double" && from !== null ? `From “${words[from]}” — now tap the last word` : `${info.label}: ${info.about}. Tap a word — here or in the text below.`}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {words.map((w, i) => {
          const marked = items.some((m) => m.kind === tool && (m.at === i || (tool === "double" && i >= m.at && i <= (m.to ?? m.at))));
          return (
            <button
              key={i}
              className={`rounded-lg px-2 py-1.5 text-[15px] ${from === i ? "bg-accent text-white" : marked ? "bg-accent-soft text-accent ring-1 ring-accent" : "bg-panel text-fg ring-1 ring-line"}`}
              onClick={() => tap(i)}
            >
              {w}
            </button>
          );
        })}
      </div>
      <p className="rounded-xl bg-panel px-3 py-2 text-[17px] leading-relaxed">
        <MarkedText text={text} marks={items} onWord={tap} />
      </p>
      <div className="flex items-center gap-2">
        <button className="text-xs text-muted underline" onClick={() => setItems([])}>
          Clear all
        </button>
        <span className="flex-1" />
        <button className="rounded-full bg-panel px-4 py-2 text-sm font-semibold" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-primary rounded-full px-5 py-2 text-sm" onClick={() => onSave(items)}>
          Save
        </button>
      </div>
    </div>
  );
}
