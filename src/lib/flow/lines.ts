import { prosody } from "@/lib/rhyme/prosody";
import type { TimedWord } from "@/lib/audio/lyrics";
import { fixPairs, rhymeSegments } from "./rhymelines";
import type { Syllable } from "./syllables";

/**
 * A flow take → the lines of the song, with the rhythm sung in each —
 * syllable count, which syllables were stressed, a held last note — and the
 * words that were recognised in it. With words, a line ends on its rhyme
 * (couplets, see rhymeSegments); with only "na-na", one line per bar (two
 * when bars are short).
 */

export interface FlowLine {
  /** song time where the line starts (bar line) and its first sung syllable */
  start: number;
  sungAt: number;
  end: number;
  syllables: number;
  /** stressed syllables, 1-based */
  stress: number[];
  /** the last syllable is held (wants an open, singable vowel) */
  held: boolean;
  /** recognised words sung in this line ("" when it was only "na-na") */
  words: string;
  /** song time of every sung syllable's start */
  times: number[];
  /** 1 / 2 = first / second line of a rhyming couplet, 0 = on its own (undefined: laid out by bar) */
  pair?: 0 | 1 | 2;
}

export interface FlowGrid {
  bpm: number | null;
  beat_offset: number;
  beats_per_bar: number;
}

/** sung syllables starting a little before the bar line belong to it (pickups) */
const LEAD = 0.18;

export function flowLines(
  syllables: Syllable[],
  words: TimedWord[],
  grid: FlowGrid,
  opts: { offset?: number; lang: string; duration: number },
): FlowLine[] {
  const shift = opts.offset ?? 0; // song time of sample 0
  const sy = syllables.map((s) => ({ ...s, t: s.t + shift }));
  const bar = grid.bpm ? (grid.beats_per_bar * 60) / grid.bpm : null;
  // a line = 1 bar; 2 bars when the tempo is fast (a line needs room to breathe)
  const unit = bar ? (bar < 1.9 ? 2 * bar : bar) : 2.5;
  const origin = bar ? grid.beat_offset : 0;
  // the windows the lines are cut from: by rhyme when the words cover the singing, else by bar
  const covered = words.length ? sy.filter((s) => words.some((w) => s.t >= w.start - 0.05 && s.t <= w.end + 0.05)).length : 0;
  const byRhyme = sy.length > 0 && covered / sy.length >= 0.6;
  const windows: { from: number; to: number; start: number; pair?: 0 | 1 | 2 }[] = [];
  if (byRhyme) {
    const segs = rhymeSegments(words, opts.lang, unit);
    segs.forEach((g, k) => {
      const first = words[g.from].start;
      const from = k === 0 ? Math.min(first, sy[0].t) - LEAD : first - LEAD;
      const to = k + 1 < segs.length ? words[segs[k + 1].from].start - LEAD : Infinity;
      windows.push({ from, to, start: Math.round(Math.max(0, first) * 1000) / 1000, pair: g.pair });
    });
  } else {
    const count = Math.ceil((opts.duration - origin) / unit) + 1;
    for (let k = 0; k < count; k++) windows.push({ from: origin + k * unit - LEAD, to: origin + (k + 1) * unit - LEAD, start: Math.round((origin + k * unit) * 1000) / 1000 });
  }
  const out: FlowLine[] = [];
  for (const { from, to, start, pair } of windows) {
    const inside = sy.filter((s) => s.t >= from && s.t < to);
    if (inside.length < 2) continue;
    const ws = words.filter((w) => w.start >= from + (byRhyme ? LEAD : 0) - 1e-9 && w.start < to + (byRhyme ? LEAD : 0) - 1e-9);
    const text = ws
      .map((w) => w.text)
      .join(" ")
      .replace(/\s+([,.!?;:])/g, "$1")
      .trim();
    // recognised words count their syllables better than the envelope; "na-na" parts only the envelope
    const fromWords = text ? prosody(text, opts.lang).syllables : 0;
    const coveredByWords = ws.length ? inside.filter((s) => ws.some((w) => s.t >= w.start - 0.05 && s.t <= w.end + 0.05)).length : 0;
    const syllableCount = Math.max(1, fromWords + (inside.length - coveredByWords));
    const loud = inside.map((s, i) => ({ i, v: s.strength })).filter((x) => x.v >= 0.8);
    // stresses on the envelope's syllables, scaled onto the counted syllables
    const scale = syllableCount / inside.length;
    const stress = [...new Set(loud.map((x) => Math.min(syllableCount, Math.max(1, Math.round((x.i + 0.5) * scale + 0.5)))))].sort((a, b) => a - b);
    const last = inside[inside.length - 1];
    out.push({
      start,
      sungAt: inside[0].t,
      end: Math.round((last.t + last.dur) * 1000) / 1000,
      syllables: syllableCount,
      stress,
      held: last.dur >= 0.35,
      words: text,
      times: inside.map((s) => Math.round(s.t * 1000) / 1000),
      pair,
    });
  }
  return byRhyme ? fixPairs(out) : out;
}

/** "da-DUM-da-da-DUM…" for prompts and the pattern view */
export function stressPattern(l: Pick<FlowLine, "syllables" | "stress" | "held">) {
  const s = new Set(l.stress);
  const parts = Array.from({ length: l.syllables }, (_, i) => (s.has(i + 1) ? "DUM" : "da"));
  if (l.held && parts.length) parts[parts.length - 1] += "~";
  return parts.join("-");
}
