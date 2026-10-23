import type { TimedWord } from "@/lib/audio/lyrics";
import { analyzeLine, compareLines } from "@/lib/rhyme/analyze";
import { isWeakWord, prosody } from "@/lib/rhyme/prosody";

/**
 * Where the lines of a sung text break. The singing decides first: a pause
 * (the singer breathes) and the punctuation the recognition put there
 * ("divide," / "un po'.") end a line. Where the singing runs on without a
 * break, the rhyme decides: lines pair up in couplets whose last words rhyme
 * ("…la notte / …più forte"). Every line stays about a bar long and never
 * ends on "e", "che", "la"…
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

const COUPLET: Record<string, number> = { perfect: 2, assonance: 1.4, identical: 0.6, consonance: 0.4 };
const LONG_GAP = 1.6; // a silence this long always ends a line
const MAX_WORDS = 30;
const MIN_SYLLABLES = 4;
/** "da te", "con me": pronouns at the end of a line are stressed and rhyme */
const STRESSED_AT_END = new Set(["me", "te", "sé", "lui", "lei", "noi", "voi", "you", "moi", "toi"]);

const clean = (w: string) => w.replace(/[^\p{L}\p{N}']+/gu, "");

/** how strongly the singing breaks after a word: its pause and its punctuation */
function breakAfter(word: TimedWord, gap: number) {
  const punct = /[.!?…]["»”']*$/.test(word.text) ? 2.5 : /[,;:—–-]["»”']*$/.test(word.text) ? 1.6 : 0;
  const pause = gap > LONG_GAP ? 3 : gap > 0.6 ? 2 : gap > 0.35 ? 1.2 : gap > 0.2 ? 0.5 : -1;
  return punct + pause;
}

export function rhymeSegments(words: TimedWord[], lang: string, unit: number): Segment[] {
  const n = words.length;
  if (!n) return [];
  const gapAfter = (j: number) => (j >= n - 1 ? Infinity : words[j + 1].start - words[j].end);
  // a line can only end (and rhyme) on a stressed word
  const ends = words.map((w) => {
    const c = clean(w.text);
    return c && (!isWeakWord(c, lang) || STRESSED_AT_END.has(c.toLowerCase())) ? analyzeLine(c, lang) : null;
  });
  const syl = words.map((w) => Math.max(1, prosody(clean(w.text) || "a", lang).syllables));
  const couplet = (a: number, b: number) => {
    const x = ends[a];
    const y = ends[b];
    return x && y ? (COUPLET[compareLines(x, y).quality] ?? -Infinity) : -Infinity;
  };
  const end = (j: number) => {
    if (j >= n - 1) return 3;
    const g = gapAfter(j);
    // ending on a function word ("…e", "…a") cuts the phrase — only where the singer really stops
    return ends[j] || g > LONG_GAP ? breakAfter(words[j], g) : breakAfter(words[j], g) - 4;
  };
  const length = (i: number, j: number) => {
    const d = words[j].end - words[i].start;
    // a bar is the natural length; up to ~1.6 bars is fine for a long phrase
    return d < unit ? -1.2 * ((unit - d) / unit) : -0.8 * Math.max(0, d - 1.3 * unit) / unit;
  };

  // best[i][p]: best score for the words from i on, the line starting at i being the 2nd of a couplet (p = 1) or not
  const best = Array.from({ length: n + 1 }, () => [-Infinity, -Infinity]);
  const next = Array.from({ length: n + 1 }, () => [
    { j: -1, p: 0 },
    { j: -1, p: 0 },
  ]);
  best[n] = [0, -Infinity];
  for (let i = n - 1; i >= 0; i--) {
    let count = 0;
    for (let j = i; j < Math.min(n, i + MAX_WORDS); j++) {
      if (j > i && gapAfter(j - 1) > LONG_GAP) break; // no line across a long silence
      if (words[j].end - words[i].start > 2.4 * unit && j > i) break;
      count += syl[j];
      // too short for a line, unless the singing stops here
      if (count < MIN_SYLLABLES && j < n - 1 && gapAfter(j) <= LONG_GAP) continue;
      const base = length(i, j) + end(j);
      // a line on its own, or the 1st of a couplet (its partner follows)
      for (const [score, p] of [
        [base + best[j + 1][0], 0],
        [base + best[j + 1][1], 1],
      ] as const) {
        if (score > best[i][0]) {
          best[i][0] = score;
          next[i][0] = { j, p };
        }
      }
      // the 2nd line of a couplet: it rhymes with the word before it starts (the 1st line's end)
      if (i > 0 && gapAfter(i - 1) <= LONG_GAP) {
        const second = base + couplet(i - 1, j) + best[j + 1][0];
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
