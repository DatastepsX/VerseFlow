import type { TimedWord } from "@/lib/audio/lyrics";
import { prosody } from "@/lib/rhyme/prosody";
import { flowLines, type FlowGrid, type FlowLine } from "./lines";
import type { Syllable } from "./syllables";

/**
 * A song that already has vocals on it: the recognised words (with timing)
 * give the syllables — each word's syllables spread over the time it was
 * sung, its stressed syllable marked — so the lines come out of the same bar
 * layout as a recorded flow, with the words as their text.
 */
export function syllablesFromWords(words: TimedWord[], lang: string): Syllable[] {
  const out: Syllable[] = [];
  for (const w of words) {
    const p = prosody(w.text, lang);
    const n = Math.max(1, p.syllables);
    const len = Math.max(0.05, w.end - w.start);
    const stressed = new Set(p.stresses.length ? p.stresses : [n - 1]);
    for (let i = 0; i < n; i++) {
      out.push({ t: w.start + (i * len) / n, strength: stressed.has(i) ? 1 : 0.5, dur: len / n });
    }
  }
  return out;
}

export function vocalLines(words: TimedWord[], grid: FlowGrid, opts: { lang: string; duration: number }): FlowLine[] {
  return flowLines(syllablesFromWords(words, opts.lang), words, grid, { offset: 0, ...opts })
    .filter((l) => l.words.trim())
    .map((l) => {
      // the words are the lyrics: their own count and stresses are the pattern
      const p = prosody(l.words, opts.lang);
      return p.syllables ? { ...l, syllables: p.syllables, stress: p.stresses.map((s) => s + 1) } : l;
    });
}

/** a part of the song without vocals, to be written later: where its lines would start */
export interface EmptyPart {
  start: number;
  end: number;
  slots: number[];
}

/**
 * The parts without vocals (a verse that isn't written yet): silences of 4+
 * bars between sung lines (8+ before the first / after the last, which are
 * usually intro and outro). Each gets placeholder lines at the song's own
 * line spacing, an even number (couplets), starting on a bar line.
 */
export function emptyParts(lines: FlowLine[], grid: FlowGrid, duration: number): EmptyPart[] {
  if (!lines.length) return [];
  const bar = grid.bpm ? (grid.beats_per_bar * 60) / grid.bpm : 2.5;
  const origin = grid.bpm ? grid.beat_offset : 0;
  const steps = lines
    .slice(1)
    .map((l, i) => l.start - lines[i].start)
    .filter((d) => d > 0.4 * bar && d < 2.5 * bar)
    .sort((a, b) => a - b);
  const spacing = steps.length ? steps[Math.floor(steps.length / 2)] : bar;
  // on the bar grid
  const barAt = (t: number, dir: 1 | -1) => origin + (dir > 0 ? Math.ceil((t - origin) / bar - 1e-6) : Math.floor((t - origin) / bar + 1e-6)) * bar;
  const part = (from: number, to: number): EmptyPart | null => {
    const start = Math.max(0, barAt(from, 1));
    const end = Math.min(duration, to);
    const n = Math.floor((end - start - 0.5 * bar) / spacing / 2) * 2;
    if (n < 2) return null;
    return { start: round(start), end: round(end), slots: Array.from({ length: n }, (_, k) => round(start + k * spacing)) };
  };
  const out: EmptyPart[] = [];
  const first = lines[0];
  if (first.start - origin >= 8 * bar) {
    const p = part(origin, first.start - 0.5 * bar);
    if (p) out.push(p);
  }
  lines.forEach((l, k) => {
    const next = lines[k + 1];
    if (next && next.start - l.end >= 4 * bar) {
      const p = part(l.end + 0.5 * bar, next.start - 0.5 * bar);
      if (p) out.push(p);
    }
  });
  const last = lines[lines.length - 1];
  if (duration - last.end >= 8 * bar) {
    const p = part(last.end + 0.5 * bar, duration - bar);
    if (p) out.push(p);
  }
  return out;
}

const round = (t: number) => Math.round(t * 1000) / 1000;
