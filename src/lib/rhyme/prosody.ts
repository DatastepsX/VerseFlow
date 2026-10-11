/**
 * Rhythm fingerprint of a line: sung syllables, where the stresses fall and how
 * the line ends — and a similarity score between two lines, so suggestions can
 * match the line before them in length *and* flow.
 */
import { analyzeWord, tokenize } from "./analyze";

const ROMANCE = new Set(["it", "es", "pt"]);

// Unstressed function words: they don't carry a beat in the line.
const WEAK: Record<string, Set<string>> = {
  it: new Set(
    "il lo la i gli le l un uno una un' di a da in con su per tra fra e ed o od ma che mi ti si ci vi ne non se del dello della dei degli delle al allo alla ai agli alle dal dallo dalla dai dagli dalle nel nello nella nei negli nelle sul sullo sulla sui sugli sulle col coi me te ce".split(" "),
  ),
  en: new Set("a an the of to in on at by for and or but if as is am are was were be it its my your his her our their i you he she we they me him us them with from".split(" ")),
  es: new Set("el la los las un una unos unas de a en con por para y o pero que me te se nos le les lo del al mi tu su".split(" ")),
};

export interface Prosody {
  syllables: number;
  /** 0-based syllable positions that carry a stress */
  stresses: number[];
  /** 0 = ends on a stressed syllable (tronca), 1 = piana, 2 = sdrucciola */
  ending: number;
  /** e.g. "ta-TA-ta-ta-TA-ta" */
  pattern: string;
}

const cache = new Map<string, Prosody>();

export function prosody(text: string, lang: string): Prosody {
  const key = lang + "\u0000" + text;
  const hit = cache.get(key);
  if (hit) return hit;
  const words = tokenize(text);
  const weak = WEAK[lang] ?? WEAK.it;
  const stresses: number[] = [];
  let pos = 0;
  let prevEndsVowel = false;
  let ending = 1;
  words.forEach((raw, i) => {
    const w = raw.replace(/'/g, "");
    const p = analyzeWord(w, lang);
    if (!p.syllables) return;
    // synalepha: this word's first syllable merges into the previous one
    const merge = ROMANCE.has(lang) && i > 0 && prevEndsVowel && p.startsWithVowel ? 1 : 0;
    const start = pos - merge;
    const isWeak = weak.has(w.toLowerCase()) && p.syllables === 1;
    const isLast = i === words.length - 1;
    if (!isWeak || isLast) stresses.push(start + p.syllables - 1 - p.stressFromEnd);
    if (isLast) ending = p.stressFromEnd;
    pos = start + p.syllables;
    prevEndsVowel = p.endsWithVowel;
  });
  const syllables = Math.max(0, pos);
  const uniq = [...new Set(stresses.filter((s) => s >= 0 && s < syllables))].sort((a, b) => a - b);
  const pattern = Array.from({ length: syllables }, (_, i) => (uniq.includes(i) ? "TA" : "ta")).join("-");
  const res: Prosody = { syllables, stresses: uniq, ending, pattern };
  if (cache.size > 5000) cache.clear();
  cache.set(key, res);
  return res;
}

/** Average distance from each stress in `a` to the nearest stress in `b`, counted from the line end. */
function stressDistance(a: Prosody, b: Prosody) {
  if (!a.stresses.length || !b.stresses.length) return 2;
  const fromEnd = (p: Prosody) => p.stresses.map((s) => p.syllables - 1 - s);
  const ea = fromEnd(a);
  const eb = fromEnd(b);
  const one = (x: number[], y: number[]) => x.reduce((n, s) => n + Math.min(...y.map((t) => Math.abs(s - t))), 0) / x.length;
  return (one(ea, eb) + one(eb, ea)) / 2;
}

/**
 * 0..1 — how well `candidate` matches the rhythm of `reference`:
 * syllable count (50%), stress placement aligned from the line end (30%),
 * same ending type (20%).
 */
export function rhythmSimilarity(reference: Prosody, candidate: Prosody) {
  if (!reference.syllables || !candidate.syllables) return 0;
  const syl = Math.max(0, 1 - Math.abs(reference.syllables - candidate.syllables) / 4);
  const stress = Math.max(0, 1 - stressDistance(reference, candidate) / 2);
  const end = reference.ending === candidate.ending ? 1 : 0.4;
  return Math.round((0.5 * syl + 0.3 * stress + 0.2 * end) * 100) / 100;
}

/** Human/AI-readable description, e.g. `12 syllables, stresses on 2-5-8-11, ends piana (ta-TA-…)`. */
export function describeRhythm(p: Prosody, lang: string) {
  const endName =
    lang === "it"
      ? ["tronca (stressed last syllable)", "piana (stress on the second-to-last)", "sdrucciola (stress on the third-to-last)"][p.ending] ?? "piana"
      : ["stressed last syllable", "unstressed last syllable", "two unstressed syllables at the end"][p.ending] ?? "";
  return `${p.syllables} syllables, stresses on syllables ${p.stresses.map((s) => s + 1).join("-")}, ending ${endName} — ${p.pattern}`;
}
