import type { Syllable } from "./syllables";

/**
 * Lines of a flow sung without words ("pam pam para…"): the singer's pauses
 * end the lines. Where the singing runs on without a clear pause, lines are
 * cut at the deepest breaks near the singer's own phrase length — learned
 * from the phrases that do have clear pauses around them (else a bar).
 *
 * Dynamic programming over the syllables (song time, in order).
 */

export interface Phrase {
  /** syllable indices, inclusive */
  from: number;
  to: number;
}

const CLEAR = 0.3; // a pause this long clearly ends a phrase
const LONG = 1.6; // a silence this long always ends a line
const MIN_SYLLABLES = 3;
const MAX_SYLLABLES = 24;

const gapAfter = (sy: Syllable[], i: number) => (i >= sy.length - 1 ? Infinity : sy[i + 1].t - (sy[i].t + sy[i].dur));

/** the singer's phrase length: the median of the phrases with clear pauses on both sides (shorter pauses if none) */
export function phraseLength(sy: Syllable[], fallback: number) {
  for (const pause of [CLEAR, 0.18]) {
    const lens: number[] = [];
    let from = 0;
    for (let i = 0; i < sy.length; i++) {
      if (gapAfter(sy, i) <= pause) continue;
      const n = i - from + 1;
      if (n >= 4 && n <= 12) lens.push(sy[i].t + sy[i].dur - sy[from].t);
      from = i + 1;
    }
    if (lens.length >= 2) {
      lens.sort((a, b) => a - b);
      return lens[Math.floor(lens.length / 2)];
    }
  }
  return fallback;
}

export function phraseSegments(sy: Syllable[], fallback: number): Phrase[] {
  const n = sy.length;
  if (!n) return [];
  const unit = phraseLength(sy, fallback);
  const brk = (i: number) => {
    const g = gapAfter(sy, i);
    return g > LONG ? 4 : g > 0.5 ? 3 : g > CLEAR ? 2 : g > 0.18 ? 1 : g > 0.1 ? 0.3 : -1;
  };
  const length = (i: number, j: number) => -1.5 * (Math.abs(sy[j].t + sy[j].dur - sy[i].t - unit) / unit);
  const best = new Array<number>(n + 1).fill(-Infinity);
  const next = new Array<number>(n + 1).fill(-1);
  best[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i; j < Math.min(n, i + MAX_SYLLABLES); j++) {
      if (j > i && gapAfter(sy, j - 1) > LONG) break; // never across a long silence
      if (j - i + 1 < MIN_SYLLABLES && j < n - 1 && gapAfter(sy, j) <= LONG) continue;
      const score = brk(j) + length(i, j) + best[j + 1];
      if (score > best[i]) {
        best[i] = score;
        next[i] = j;
      }
    }
  }
  const out: Phrase[] = [];
  for (let i = 0; i < n && next[i] >= 0; i = next[i] + 1) out.push({ from: i, to: next[i] });
  return out;
}
