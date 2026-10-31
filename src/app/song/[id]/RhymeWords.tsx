"use client";

import { useEffect, useRef, useState } from "react";
import type { RhymeResult, RhymeWord } from "@/lib/rhyme/types";

/**
 * Words that rhyme with a word of the lyrics: double-tap (or double-click) a word, a sheet lists its rhymes and
 * near rhymes from the rhyme dictionary — no AI call. Tap one: the AI writes 3 lines ending on it, on the line's flow
 * (1 call), to choose from right there — or copy it.
 */

/** writing lines that end on the chosen rhyme: the lines it can be for, and what to do with the options */
export interface RhymeWrite {
  /** the line the word was tapped in, and (in a couplet) the line it rhymes with — first: the default */
  targets: { id: string; label: string; text: string }[];
  busy: (lineId: string) => boolean;
  run: (lineId: string, word: string) => Promise<unknown>;
  options: (lineId: string) => { current: string; kept: boolean; alts: { id: string; text: string }[] } | null;
  pick: (lineId: string, altId: string) => Promise<unknown>;
  keep: (lineId: string) => Promise<unknown>;
}

const norm = (w: string) => w.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const endsOn = (line: string, word: string) => norm(line.trim().split(/\s+/).pop()?.replace(/[^\p{L}\p{N}'’]+/gu, "") ?? "") === norm(word);

const WORD = /[\p{L}\p{N}'’]/u;

/** the word under a point of the screen, within `container` (a line's text may be split in syllables) */
function wordAt(container: HTMLElement, x: number, y: number): string | null {
  const d = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (p) [node, offset] = [p.offsetNode, p.offset];
  } else if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    if (r) [node, offset] = [r.startContainer, r.startOffset];
  }
  if (!node || !container.contains(node)) return null;
  // where that is in the line's whole text
  const before = document.createRange();
  before.setStart(container, 0);
  before.setEnd(node, offset);
  const text = container.textContent ?? "";
  let at = before.toString().length;
  if (at >= text.length || !WORD.test(text[at] ?? "")) at -= 1;
  if (at < 0 || !WORD.test(text[at] ?? "")) return null;
  let a = at;
  let b = at;
  while (a > 0 && WORD.test(text[a - 1])) a--;
  while (b < text.length - 1 && WORD.test(text[b + 1])) b++;
  const word = text.slice(a, b + 1).replace(/^['’]+|['’]+$/g, "");
  return word.length > 1 ? word : null;
}

/**
 * A tap that waits a moment for a second one: one tap → `onTap` (opening the line), two → `onWord` with the word
 * under them (the rhymes). On a computer a double-click does the same.
 */
export function useWordTaps(onWord: (word: string) => void) {
  const last = useRef<{ t: number; x: number; y: number; timer: ReturnType<typeof setTimeout> | null } | null>(null);
  useEffect(() => () => {
    if (last.current?.timer) clearTimeout(last.current.timer);
  }, []);
  return (e: React.MouseEvent<HTMLElement>, onTap?: () => void) => {
    const now = Date.now();
    const p = last.current;
    if (p && now - p.t < 320 && Math.abs(e.clientX - p.x) < 24 && Math.abs(e.clientY - p.y) < 24) {
      if (p.timer) clearTimeout(p.timer);
      last.current = null;
      const word = wordAt(e.currentTarget, p.x, p.y) ?? wordAt(e.currentTarget, e.clientX, e.clientY);
      window.getSelection()?.removeAllRanges();
      if (word) onWord(word);
      else onTap?.();
      return;
    }
    const timer = onTap
      ? setTimeout(() => {
          last.current = null;
          onTap();
        }, 280)
      : null;
    last.current = { t: now, x: e.clientX, y: e.clientY, timer };
  };
}

export function RhymeSheet({ word, lang, onClose, write }: { word: string; lang: string; onClose: () => void; write?: RhymeWrite }) {
  const key = `${word}|${lang}`;
  const [state, setState] = useState<{ key: string; r: RhymeResult | null } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** the rhyme chosen, the line to write, and the line written (its options shown) */
  const [chosen, setChosen] = useState<string | null>(null);
  const [target, setTarget] = useState(write?.targets[0]?.id ?? null);
  const [written, setWritten] = useState<{ lineId: string; word: string } | null>(null);
  useEffect(() => {
    let gone = false;
    void fetch(`/api/rhymes?q=${encodeURIComponent(word)}&lang=${encodeURIComponent(lang)}`)
      .then((r) => (r.ok ? (r.json() as Promise<RhymeResult>) : null))
      .then((r) => {
        if (!gone) setState({ key, r });
      })
      .catch(() => {
        if (!gone) setState({ key, r: null });
      });
    return () => {
      gone = true;
    };
  }, [word, lang, key]);
  const result = state?.key === key ? state.r : undefined;
  const copy = (w: string) =>
    void navigator.clipboard?.writeText(w).then(
      () => setCopied(w),
      () => {},
    );
  const group = (title: string, words: RhymeWord[]) => {
    // by length: the ones that fit a line's syllables are easy to find
    const bySyl = new Map<number, string[]>();
    for (const w of words) bySyl.set(w.syllables, [...(bySyl.get(w.syllables) ?? []), w.word]);
    return (
      <div className="space-y-1.5">
        <p className="label">{title}</p>
        {words.length ? (
          [...bySyl.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([n, ws]) => (
              <div key={n} className="flex flex-wrap items-center gap-1.5">
                <span className="w-9 shrink-0 font-mono text-[10px] text-muted">{n} syl</span>
                {ws.map((w) => (
                  <button
                    key={w}
                    className={`rounded-full px-2.5 py-1 text-sm font-semibold ${chosen === w ? "bg-accent text-white" : copied === w ? "bg-ok text-white" : "bg-panel-2 text-fg active:bg-accent-soft"}`}
                    onClick={() => (write ? setChosen(chosen === w ? null : w) : copy(w))}
                    aria-pressed={chosen === w}
                  >
                    {w}
                  </button>
                ))}
              </div>
            ))
        ) : (
          <p className="text-xs text-muted">None found.</p>
        )}
      </div>
    );
  };
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[80dvh] w-full max-w-lg space-y-4 overflow-auto rounded-t-3xl bg-panel px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-3"
      >
        <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
        <div>
          <h2 className="text-xl font-bold">Rhymes with “{word}”</h2>
          <p className="text-xs text-muted">
            {result?.rhymeKey ? `Sound -${result.rhymeKey} · ` : ""}
            {write ? "tap a word: 3 lines ending on it, on the line's flow" : "tap a word to copy it"}
            {copied ? ` — “${copied}” copied` : ""}
          </p>
        </div>
        {written && write && <WrittenOptions write={write} lineId={written.lineId} word={written.word} />}
        {result === undefined ? (
          <p className="py-6 text-center text-sm text-muted">Looking for rhymes…</p>
        ) : result === null ? (
          <p className="py-6 text-center text-sm text-bad">Couldn&apos;t load the rhymes — try again.</p>
        ) : (
          <>
            {group("Rhymes", result.perfect)}
            {group("Near rhymes · assonance", result.near)}
            {result.source && <p className="text-[10px] text-muted">Source: {result.source}</p>}
          </>
        )}
        {/* a rhyme chosen: write lines ending on it (1 call), or copy it */}
        {chosen && write && target && (
          <div className="sticky bottom-0 -mx-4 space-y-2 border-t border-line/60 bg-panel px-4 pb-1 pt-3">
            {write.targets.length > 1 && (
              <div className="flex rounded-full bg-panel-2 p-1" role="radiogroup" aria-label="Which line">
                {write.targets.map((t) => (
                  <button
                    key={t.id}
                    role="radio"
                    aria-checked={target === t.id}
                    className={`min-w-0 flex-1 truncate rounded-full px-2 py-1.5 text-[12px] font-semibold ${target === t.id ? "bg-panel text-fg shadow-sm" : "text-muted"}`}
                    onClick={() => setTarget(t.id)}
                    title={t.text}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            <p className="truncate px-1 text-xs text-muted">Now: “{write.targets.find((t) => t.id === target)?.text || "…"}”</p>
            <div className="flex gap-2">
              <button className="btn rounded-xl px-3 text-sm" onClick={() => copy(chosen)}>
                Copy
              </button>
              <button
                className="btn-primary flex-1 justify-center rounded-xl text-sm"
                disabled={write.busy(target)}
                onClick={async () => {
                  const [id, w] = [target, chosen];
                  await write.run(id, w);
                  setWritten({ lineId: id, word: w });
                  setChosen(null);
                }}
              >
                {write.busy(target) ? "Writing…" : `Write 3 lines ending on “${chosen}” · 1 call`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** the lines just written on the chosen rhyme: tap one to put it in, then keep it */
function WrittenOptions({ write, lineId, word }: { write: RhymeWrite; lineId: string; word: string }) {
  const o = write.options(lineId);
  if (!o) return null;
  const all = [{ id: null as string | null, text: o.current }, ...o.alts];
  // the ones ending on the chosen word; the line as it was stays to go back to
  const shown = [...all.filter((x) => endsOn(x.text, word)), ...all.filter((x) => x.id === null && !endsOn(x.text, word))];
  const busy = write.busy(lineId);
  return (
    <div className="space-y-1.5 rounded-2xl bg-accent-soft/50 p-2.5">
      <p className="px-1 text-xs font-semibold text-accent">Lines ending on “{word}” · tap one, then keep it</p>
      {shown.map((x, i) => {
        const on = x.id === null;
        return (
          <button
            key={x.id ?? "current"}
            className={`flex w-full items-start gap-2 rounded-xl px-2.5 py-2 text-left text-sm ring-1 disabled:opacity-60 ${on ? "bg-panel ring-accent" : "bg-panel ring-line/60 active:bg-panel-2"}`}
            disabled={busy || on}
            onClick={() => x.id && void write.pick(lineId, x.id)}
            aria-pressed={on}
          >
            <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${on ? "bg-accent text-white" : "bg-panel-2 text-muted"}`}>
              {on ? "✓" : i + 1}
            </span>
            <span className="min-w-0 flex-1">{x.text}</span>
          </button>
        );
      })}
      <button
        className="flex h-9 w-full items-center justify-center rounded-xl bg-ok-soft text-sm font-semibold text-ok disabled:opacity-50"
        disabled={busy || (o.kept && !endsOn(o.current, word))}
        onClick={() => void write.keep(lineId)}
      >
        {o.kept ? "Kept" : "Keep this line"}
      </button>
    </div>
  );
}
