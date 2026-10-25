import { analyzeWord, tokenize } from "./analyze";
import { prosody } from "./prosody";

/**
 * A line split into its sung syllables, the way the app counts them:
 * "Ti scrivo dentro me" → ["Ti", "scri", "vo", "den", "tro", "me"];
 * vowels that merge across words (synalepha) stay one syllable: "dentro il"
 * → "tro‿il". Returns null when the written split can't be matched to the
 * count (then show the line as it is). Italian-style rules — Romance
 * languages only.
 */

const ROMANCE = new Set(["it", "es", "pt"]);
const V = "aeiouàáâèéêìíîòóôùúûy";
const isV = (c: string | undefined) => !!c && V.includes(c.toLowerCase());
const STRONG = "aeoàáâèéêòóô";
const ACCENT = /[àáâèéêìíîòóôùúû]/i;
/** consonant pairs that start a syllable together (tr, pr, gn, ch…) */
const ONSET = /^(?:[bcdfgptv][lr]|ch|gh|gn|gl|sc|qu|gu)/i;

/** a written word → syllables, aiming at `n` (the count the phonology found) */
function splitWord(w: string, n: number): string[] | null {
  if (n <= 1) return [w];
  const lw = w.toLowerCase();
  // vowel runs = candidate nuclei; a silent i (ci/gi/sci/gli + vowel) and the u of qu/gu belong to the run
  const runs: [number, number][] = [];
  for (let i = 0; i < w.length; i++) {
    if (!isV(lw[i])) continue;
    let j = i;
    while (j < w.length && isV(lw[j])) j++;
    runs.push([i, j]);
    i = j - 1;
  }
  // split runs at hiatus points until the count matches: strong+strong ("pa-e-se"), an accented vowel ("mi-o")
  const pieces: [number, number][] = [];
  let extra = n - runs.length;
  for (const [a, b] of runs) {
    let start = a;
    for (let k = a + 1; k < b && extra > 0; k++) {
      const x = lw[k - 1];
      const y = lw[k];
      const silentI = x === "i" && k - 1 > 0 && /[cg]/.test(lw[k - 2]);
      const uGlide = x === "u" && k - 1 > 0 && /[qg]/.test(lw[k - 2]);
      if (silentI || uGlide) continue;
      if ((STRONG.includes(x) && STRONG.includes(y)) || ACCENT.test(x) || ACCENT.test(y)) {
        pieces.push([start, k]);
        start = k;
        extra--;
      }
    }
    pieces.push([start, b]);
  }
  // still short: split remaining two-vowel runs from the end ("tu-o", "mi-a")
  for (let p = pieces.length - 1; extra > 0 && p >= 0; p--) {
    const [a, b] = pieces[p];
    if (b - a >= 2 && !(lw[a] === "i" && a > 0 && /[cg]/.test(lw[a - 1])) && !(lw[a] === "u" && a > 0 && /[qg]/.test(lw[a - 1]))) {
      pieces.splice(p, 1, [a, b - 1], [b - 1, b]);
      extra--;
    }
  }
  if (pieces.length !== n) return null;
  // consonants between nuclei: one → the next syllable; double → split; s+C and tr/pr/gn… → the next; else 1 | rest
  const cuts: number[] = [];
  for (let p = 0; p < pieces.length - 1; p++) {
    const from = pieces[p][1];
    const to = pieces[p + 1][0];
    const c = lw.slice(from, to);
    let cut = from;
    if (c.length === 1) cut = from;
    else if (c.length >= 2) {
      if (c[0] === c[1]) cut = from + 1;
      else if (c[0] === "s" || ONSET.test(c)) cut = from;
      else cut = from + 1;
    }
    cuts.push(cut);
  }
  const out: string[] = [];
  let last = 0;
  for (const c of cuts) {
    out.push(w.slice(last, c));
    last = c;
  }
  out.push(w.slice(last));
  return out.every(Boolean) ? out : null;
}

export function syllabify(text: string, lang: string): string[] | null {
  return syllableParts(text, lang)?.map((p) => p.text.replace(/ /g, "‿")) ?? null;
}

/** a syllable as written: its letters, and whether a word starts with it (a space before it) */
export interface SyllablePart {
  text: string;
  space: boolean;
}

/** the line's syllables with the spaces between words kept (a merged syllable keeps its inner space: "ne an") */
export function syllableParts(text: string, lang: string, commaPauses = false): SyllablePart[] | null {
  if (!ROMANCE.has(lang)) return null;
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out: SyllablePart[] = [];
  let prevEndsVowel = false;
  for (const [i, raw] of words.entries()) {
    const core = tokenize(raw)[0];
    if (!core) {
      // punctuation alone ("—"): stick it to the previous syllable
      if (out.length) out[out.length - 1].text += " " + raw;
      continue;
    }
    const p = analyzeWord(core.replace(/'/g, ""), lang);
    if (!p.syllables) {
      if (out.length) out[out.length - 1].text += " " + raw;
      else out.push({ text: raw, space: false });
      continue;
    }
    const lead = raw.slice(0, raw.indexOf(core.charAt(0)));
    const tail = raw.slice(raw.indexOf(core.charAt(0)) + core.length);
    const parts = splitWord(core, p.syllables);
    if (!parts) return null;
    parts[0] = lead + parts[0];
    parts[parts.length - 1] += tail;
    // synalepha: this word's first syllable merges into the previous one
    // (with commaPauses, not across a comma: "notte, io" sung with a break)
    const merged = i > 0 && prevEndsVowel && p.startsWithVowel && out.length > 0 && !(commaPauses && /[,;:.!?…]["»”’)]*$/.test(words[i - 1]));
    if (merged) out[out.length - 1].text += " " + parts.shift();
    // the word's first syllable gets the space (unless it merged into the previous word's last one)
    const firstOfWord = out.length > 0 && !merged;
    out.push(...parts.map((x, k) => ({ text: x, space: k === 0 && firstOfWord })));
    prevEndsVowel = p.endsWithVowel;
  }
  return out.length === prosody(text, lang, commaPauses).syllables ? out : null;
}
