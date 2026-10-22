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
