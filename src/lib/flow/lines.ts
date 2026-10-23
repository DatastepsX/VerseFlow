import { prosody } from "@/lib/rhyme/prosody";
import type { TimedWord } from "@/lib/audio/lyrics";
import { phraseSegments } from "./phrases";
import { fixPairs, rhymeSegments } from "./rhymelines";
import type { Syllable } from "./syllables";

/**
 * A flow take → the lines of the song, with the rhythm sung in each —
 * syllable count, which syllables were stressed, a held last note — and the
 * words that were recognised in it. Your singing breaks the lines: with
 * words, pauses + punctuation, then the rhyme (couplets, see rhymeSegments);
 * with only "na-na", your pauses and your phrase length (phraseSegments).
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
  /** sounds: sung sounds recognised as "words" ("pom pom para") — they count syllables, but aren't lyrics */
  /** breaks: where the writer said a new line starts (syllable indices, from tapping "next line") */
  opts: { offset?: number; lang: string; duration: number; sounds?: TimedWord[]; breaks?: number[] },
): FlowLine[] {
  const shift = opts.offset ?? 0; // song time of sample 0
  const sy = syllables.map((s) => ({ ...s, t: s.t + shift }));
  const bar = grid.bpm ? (grid.beats_per_bar * 60) / grid.bpm : null;
  // a line = 1 bar; 2 bars when the tempo is fast (a line needs room to breathe)
  const unit = bar ? (bar < 1.9 ? 2 * bar : bar) : 2.5;
  // the lines: by the words (pauses, punctuation, rhyme) when they cover the singing, else by the singing's own phrases
  const covered = words.length ? sy.filter((s) => words.some((w) => s.t >= w.start - 0.05 && s.t <= w.end + 0.05)).length : 0;
  const byRhyme = sy.length > 0 && covered / sy.length >= 0.6;
  const groups: { inside: Syllable[]; ws: TimedWord[]; from: number; to: number; start: number; pair?: 0 | 1 | 2 }[] = [];
  if (byRhyme) {
    const segs = rhymeSegments(words, opts.lang, unit);
    segs.forEach((g, k) => {
      const first = words[g.from].start;
      const from = k === 0 ? Math.min(first, sy[0].t) - LEAD : first - LEAD;
      const to = k + 1 < segs.length ? words[segs[k + 1].from].start - LEAD : Infinity;
      groups.push({
        inside: sy.filter((s) => s.t >= from && s.t < to),
        ws: words.slice(g.from, g.to + 1),
        from,
        to,
        start: Math.round(Math.max(0, first) * 1000) / 1000,
        pair: g.pair,
      });
    });
  } else {
    // lines as the writer marked them ("next line"), else by the singing's own pauses
    const marks = opts.breaks?.length ? [...new Set([0, ...opts.breaks])].filter((b) => b > 0 && b < sy.length).sort((a, b) => a - b) : null;
    const segs = marks ? [0, ...marks].map((from, i, a) => ({ from, to: (a[i + 1] ?? sy.length) - 1 })) : phraseSegments(sy, unit);
    segs.forEach((g, k) => {
      const inside = sy.slice(g.from, g.to + 1);
      const from = inside[0].t - 0.1;
      const to = k + 1 < segs.length ? sy[segs[k + 1].from].t - 0.1 : Infinity;
      // couplets in order (1+2, 3+4…), restarting after a long silence
      const prevEnd = k > 0 ? sy[segs[k - 1].to].t + sy[segs[k - 1].to].dur : -Infinity;
      const prevPair = groups[groups.length - 1]?.pair;
      const pair: 1 | 2 = prevPair === 1 && inside[0].t - prevEnd <= 1.6 ? 2 : 1;
      groups.push({ inside, ws: words.filter((w) => w.start >= from && w.start < to), from, to, start: Math.round(Math.max(0, inside[0].t) * 1000) / 1000, pair });
    });
  }
  const out: FlowLine[] = [];
  for (const { inside, ws, from, to, start, pair } of groups) {
    if (inside.length < (opts.breaks?.length ? 1 : 2)) continue;
    const text = ws
      .map((w) => w.text)
      .join(" ")
      .replace(/\s+([,.!?;:])/g, "$1")
      .trim();
    // recognised words count their syllables better than the envelope; "na-na" parts only the envelope
    // sung sounds ("pom", "para") count like words: "para" = 2 syllables even when the envelope heard one
    const snd = (opts.sounds ?? []).filter((w) => w.start >= from && w.start < to);
    const fromWords = (text ? prosody(text, opts.lang).syllables : 0) + snd.reduce((n, w) => n + Math.max(1, prosody(w.text, opts.lang).syllables), 0);
    const counted = [...ws, ...snd];
    const coveredByWords = counted.length ? inside.filter((s) => counted.some((w) => s.t >= w.start - 0.05 && s.t <= w.end + 0.05)).length : 0;
    const syllableCount = Math.max(1, fromWords + (inside.length - coveredByWords));
    // stressed: the loudest of the line, a syllable that stands out from its neighbours, or one leaned into (long); a held last note too
    const durs = inside.map((s) => s.dur).sort((a, b) => a - b);
    const typical = durs[Math.floor(durs.length / 2)] || 0.1;
    const top = Math.max(...inside.map((s) => s.strength)) || 1;
    const loud = inside
      .map((s, i) => {
        const v = s.strength / top;
        const nb = [inside[i - 1], inside[i + 1]].filter(Boolean).map((x) => x.strength / top);
        const ratio = v / (nb.reduce((a, b) => a + b, 0) / (nb.length || 1) || 1);
        return { i, v, d: s.dur, ratio };
      })
      .filter(
        (x) => x.v >= 0.85 || (x.ratio >= 1.2 && x.v >= 0.35) || (x.d >= 1.8 * typical && x.v >= 0.4) || (x.i === inside.length - 1 && x.d >= 0.35),
      );
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
  return fixPairs(out);
}

/** "da-DUM-da-da-DUM…" for prompts and the pattern view */
export function stressPattern(l: Pick<FlowLine, "syllables" | "stress" | "held">) {
  const s = new Set(l.stress);
  const parts = Array.from({ length: l.syllables }, (_, i) => (s.has(i + 1) ? "DUM" : "da"));
  if (l.held && parts.length) parts[parts.length - 1] += "~";
  return parts.join("-");
}
