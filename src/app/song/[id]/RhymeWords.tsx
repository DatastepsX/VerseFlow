"use client";

import { useEffect, useRef, useState } from "react";
import type { RhymeResult, RhymeWord } from "@/lib/rhyme/types";

/**
 * Words that rhyme with a word of the lyrics: double-tap (or double-click) a word, a sheet lists its rhymes and
 * near rhymes from the rhyme dictionary — no AI call. Tap one to copy it.
 */

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

export function RhymeSheet({ word, lang, onClose }: { word: string; lang: string; onClose: () => void }) {
  const key = `${word}|${lang}`;
  const [state, setState] = useState<{ key: string; r: RhymeResult | null } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
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
                    className={`rounded-full px-2.5 py-1 text-sm font-semibold ${copied === w ? "bg-ok text-white" : "bg-panel-2 text-fg active:bg-accent-soft"}`}
                    onClick={() => copy(w)}
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
            {result?.rhymeKey ? `Sound -${result.rhymeKey} · ` : ""}tap a word to copy it{copied ? ` — “${copied}” copied` : ""}
          </p>
        </div>
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
      </div>
    </div>
  );
}
