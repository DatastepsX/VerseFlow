import { analyzeEnglishWord } from "./english";
import { analyzeItalianWord } from "./italian";
import type { LineAnalysis, RhymeMatch, WordPhonology } from "./types";

export type { LineAnalysis, RhymeMatch, RhymeQuality, WordPhonology } from "./types";

const ROMANCE = new Set(["it", "es", "pt"]);

export function analyzeWord(word: string, lang: string): WordPhonology {
  return lang === "en" ? analyzeEnglishWord(word) : analyzeItalianWord(word);
}

/** Split a line into words; Italian elisions ("dell'amore") stay one sung unit. */
export function tokenize(text: string): string[] {
  return text
    .replace(/[’`´]/g, "'")
    .replace(/[“”"«»()[\]{}.,;:!?¿¡…–—\-/\\*_#~]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => /[\p{L}]/u.test(w));
}

export function lastWord(text: string): string {
  const t = tokenize(text);
  const w = t[t.length - 1] ?? "";
  // for elisions take the part after the apostrophe: "dell'amore" → "amore"
  const parts = w.split("'");
  return parts[parts.length - 1];
}

const cache = new Map<string, LineAnalysis>();

export function analyzeLine(text: string, lang: string): LineAnalysis {
  const cacheKey = lang + "\u0000" + text;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const words = tokenize(text);
  const phon = words.map((w) => analyzeWord(w.replace(/'/g, ""), lang));
  let syllables = phon.reduce((n, p) => n + p.syllables, 0);
  if (ROMANCE.has(lang)) {
    // synalepha: a word ending in a vowel merges with the next word starting with a vowel
    for (let i = 0; i < phon.length - 1; i++) {
      if (phon[i].endsWithVowel && phon[i + 1].startsWithVowel && phon[i].syllables > 0) syllables--;
    }
  }
  const lw = lastWord(text);
  const last = lw ? analyzeWord(lw, lang) : null;
  const result: LineAnalysis = {
    syllables: Math.max(0, syllables),
    lastWord: lw,
    rhymeKey: last?.rhymeKey ?? "",
    vowelTail: last?.vowelTail ?? "",
    lineVowels: phon.map((p) => p.vowels).join(""),
    stressFromEnd: last?.stressFromEnd ?? 0,
  };
  if (cache.size > 5000) cache.clear();
  cache.set(cacheKey, result);
  return result;
}

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function consonants(s: string): string {
  return s.replace(/[aeiouAEIOUWY]/g, "");
}

/** How well two analysed lines rhyme at their ends. */
export function compareLines(a: LineAnalysis, b: LineAnalysis): RhymeMatch {
  if (!a.rhymeKey || !b.rhymeKey) return { quality: "none", score: 0, depth: 0 };
  const depth = commonSuffix(a.lineVowels, b.lineVowels);
  const bonus = Math.min(0.15, Math.max(0, depth - a.vowelTail.length) * 0.05);
  if (a.lastWord.toLowerCase() === b.lastWord.toLowerCase()) {
    return { quality: "identical", score: 0.6, depth };
  }
  if (a.rhymeKey === b.rhymeKey) {
    return { quality: "perfect", score: Math.min(1, 0.9 + bonus), depth };
  }
  if (a.vowelTail && a.vowelTail === b.vowelTail) {
    // assonance — closer when consonants are similar too (ghiaccio / spacco)
    const ca = consonants(a.rhymeKey);
    const cb = consonants(b.rhymeKey);
    const shared = commonSuffix(ca, cb) + (ca[0] === cb[0] ? 1 : 0);
    return { quality: "assonance", score: Math.min(0.85, 0.55 + shared * 0.05 + bonus), depth };
  }
  if (
    a.rhymeKey.length > 2 &&
    consonants(a.rhymeKey) === consonants(b.rhymeKey) &&
    consonants(a.rhymeKey).length >= 2
  ) {
    return { quality: "consonance", score: 0.35, depth };
  }
  return { quality: "none", score: 0, depth };
}

export interface SchemeEntry {
  /** rhyme letter (A, B, …) or null when the line rhymes with nothing */
  letter: string | null;
  /** index (in the input array) of the closest line it rhymes with */
  partner: number | null;
  match: RhymeMatch | null;
}

/**
 * Assign rhyme letters to a sequence of lines (AABB, ABAB…). A line takes the
 * letter of the best-rhyming earlier line within the look-back window.
 */
export function rhymeScheme(texts: string[], lang: string, lookBack = 4): SchemeEntry[] {
  const analyses = texts.map((t) => (t.trim() ? analyzeLine(t, lang) : null));
  const letters: (string | null)[] = [];
  const out: SchemeEntry[] = [];
  let next = 0;
  for (let i = 0; i < analyses.length; i++) {
    const a = analyses[i];
    if (!a) {
      letters.push(null);
      out.push({ letter: null, partner: null, match: null });
      continue;
    }
    let best: { j: number; m: RhymeMatch } | null = null;
    for (let j = i - 1; j >= Math.max(0, i - lookBack); j--) {
      const b = analyses[j];
      if (!b) continue;
      const m = compareLines(a, b);
      if (m.quality === "none" || m.quality === "consonance") continue;
      if (!best || m.score > best.m.score) best = { j, m };
    }
    if (best && letters[best.j]) {
      letters.push(letters[best.j]);
      out.push({ letter: letters[best.j], partner: best.j, match: best.m });
    } else {
      const l = String.fromCharCode(65 + (next++ % 26));
      letters.push(l);
      out.push({ letter: l, partner: best?.j ?? null, match: best?.m ?? null });
    }
  }
  // letters used only once don't mark a rhyme
  const counts = new Map<string, number>();
  for (const l of letters) if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  // re-letter so the scheme reads A, B, C in order of appearance
  const remap = new Map<string, string>();
  let k = 0;
  return out.map((e) => {
    if (!e.letter || (counts.get(e.letter) ?? 0) < 2) return { ...e, letter: null };
    if (!remap.has(e.letter)) remap.set(e.letter, String.fromCharCode(65 + (k++ % 26)));
    return { ...e, letter: remap.get(e.letter)! };
  });
}
