import type { TimedWord } from "@/lib/audio/lyrics";
import { analyzeLine, compareLines } from "@/lib/rhyme/analyze";
import { isWeakWord, prosody } from "@/lib/rhyme/prosody";

/**
 * Where the lines of a sung text break: a line ends on its rhyme. The
 * recognised words are split so that lines pair up in couplets whose last
 * words rhyme ("…la notte / …più forte"), each line about a bar long (the
 * flow's unit) and breaking where the singer breathes. Lines that rhyme with
 * nothing are allowed, but cost more than a couplet.
 *
 * Dynamic programming over (first word of the line, is it the 2nd of a couplet).
 */

export interface Segment {
  /** word indices, inclusive */
  from: number;
  to: number;
  /** 1 / 2 = first / second line of a rhyming couplet, 0 = a line on its own */
  pair: 0 | 1 | 2;
}

const RHYME: Record<string, number> = { perfect: 3, assonance: 2.2, identical: 1, consonance: 0.6, none: -1.5 };
const SINGLE = -1.2; // a line outside a couplet
const LONG_GAP = 1.6; // a silence this long always ends a line
const MAX_WORDS = 30;
const MIN_SYLLABLES = 4;
/** "da te", "con me": pronouns at the end of a line are stressed and rhyme */
const STRESSED_AT_END = new Set(["me", "te", "sé", "lui", "lei", "noi", "voi", "you", "me", "moi", "toi"]);

const clean = (w: string) => w.replace(/[^\p{L}\p{N}']+/gu, "");

export function rhymeSegments(words: TimedWord[], lang: string, unit: number): Segment[] {
  const n = words.length;
  if (!n) return [];
  const gapAfter = (j: number) => (j >= n - 1 ? Infinity : words[j + 1].start - words[j].end);
  // a line can only end (and rhyme) on a stressed word: never on "e", "che", "la"…
  const ends = words.map((w) => {
    const c = clean(w.text);
    return c && (!isWeakWord(c, lang) || STRESSED_AT_END.has(c.toLowerCase())) ? analyzeLine(c, lang) : null;
  });
  const syl = words.map((w) => Math.max(1, prosody(clean(w.text) || "a", lang).syllables));
  const rhyme = (a: number, b: number) => {
    const x = ends[a];
    const y = ends[b];
    return x && y ? RHYME[compareLines(x, y).quality] : RHYME.none;
  };
  const pause = (j: number) => {
    const g = gapAfter(j);
    const p = g > LONG_GAP ? 1.5 : g > 0.6 ? 1 : g > 0.25 ? 0.5 : -0.5;
    // ending on a function word ("…e", "…che") cuts the phrase — only where the singer stops anyway
    return ends[j] || g > LONG_GAP ? p : p - 2;
  };
  const length = (i: number, j: number) => {
    const d = words[j].end - words[i].start;
    return -1.5 * (Math.abs(d - unit) / unit);
  };

  // best[i][p]: best score for the words from i on, the line starting at i being the 2nd of a couplet (p = 1) or not
  const best = Array.from({ length: n + 1 }, () => [-Infinity, -Infinity]);
  const next: { j: number; p: number }[][] = Array.from({ length: n + 1 }, () => [
    { j: -1, p: 0 },
    { j: -1, p: 0 },
  ]);
  best[n] = [0, SINGLE]; // a couplet left open at the end: its first line was single
  for (let i = n - 1; i >= 0; i--) {
    let count = 0;
    for (let j = i; j < Math.min(n, i + MAX_WORDS); j++) {
      if (j > i && gapAfter(j - 1) > LONG_GAP) break; // no line across a long silence
      const d = words[j].end - words[i].start;
      if (d > 2.2 * unit && j > i) break;
      count += syl[j];
      // too short for a line, unless the singing stops here
      if (count < MIN_SYLLABLES && j < n - 1 && gapAfter(j) <= LONG_GAP) continue;
      const base = length(i, j) + pause(j);
      // 1st line of a couplet, or a single line
      const first = base + best[j + 1][1];
      const single = base + SINGLE + best[j + 1][0];
      if (first > best[i][0]) {
        best[i][0] = first;
        next[i][0] = { j, p: 1 };
      }
      if (single > best[i][0]) {
        best[i][0] = single;
        next[i][0] = { j, p: 0 };
      }
      // 2nd line of a couplet: its last word rhymes with the word before it starts (the 1st line's end)
      if (i > 0) {
        const second = base + rhyme(i - 1, j) + best[j + 1][0];
        if (second > best[i][1]) {
          best[i][1] = second;
          next[i][1] = { j, p: 0 };
        }
      }
    }
  }
  const out: Segment[] = [];
  for (let i = 0, p = 0; i < n; ) {
    const s = next[i][p];
    if (s.j < 0) break;
    out.push({ from: i, to: s.j, pair: p === 1 ? 2 : s.p === 1 ? 1 : 0 });
    i = s.j + 1;
    p = s.p;
  }
  return fixPairs(out);
}

/** a 1st line needs its 2nd right after it (and the other way round) — after lines were dropped, too */
export function fixPairs<T extends { pair?: 0 | 1 | 2 }>(lines: T[]): T[] {
  return lines.map((l, k) => {
    if (l.pair === 1 && lines[k + 1]?.pair !== 2) return { ...l, pair: 0 };
    if (l.pair === 2 && lines[k - 1]?.pair !== 1) return { ...l, pair: 0 };
    return l;
  });
}
