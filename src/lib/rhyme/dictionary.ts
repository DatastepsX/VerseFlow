import "server-only";
import { analyzeItalianWord, COMMON_OXYTONES } from "./italian";
import { analyzeWord, lastWord } from "./analyze";
import type { RhymeResult, RhymeWord } from "./types";

export type { RhymeResult, RhymeWord } from "./types";

interface Entry {
  word: string;
  rank: number;
  key: string;
  vowels: string;
  syllables: number;
}

const SHORT_WORDS = new Set(
  "io tu me te se re ne da di fa va sa ma ha la lo li le ci vi mi ti si no so do ho ai tre due tra fra blu".split(" "),
);

let italian: { byKey: Map<string, Entry[]>; byVowels: Map<string, Entry[]> } | null = null;

function loadItalian() {
  if (italian) return italian;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const list: string[] = require("an-array-of-italian-words/words.json");
  const rank = new Map<string, number>();
  list.forEach((w, i) => {
    if (!rank.has(w)) rank.set(w, i);
  });
  // The list lost its accents ("città" → "citta") and contains fragments of
  // badly tokenised words ("urante" from "durante"). Drop a word when the same
  // word with one more leading letter exists and is more frequent.
  const isFragment = (w: string, r: number) => {
    // impossible Italian word starts: "nna", "mbria", "pple"
    if (/^([bcdfglmnpqrstvz])\1|^[lnmr][^aeiou]|^[^aeiou]{4}/.test(w)) return true;
    if (w.length < 3) return !SHORT_WORDS.has(w);
    if (w.length < 5 && !/^[aeiou]/.test(w)) return false;
    for (const c of "abcdefghilmnopqrstuvz") {
      const longer = rank.get(c + w);
      if (longer !== undefined && longer < r) return true;
    }
    return false;
  };
  const oxyPlain = new Map(COMMON_OXYTONES.map((w) => [w.normalize("NFD").replace(/[\u0300-\u036f]/g, ""), w]));
  const byKey = new Map<string, Entry[]>();
  const byVowels = new Map<string, Entry[]>();
  const add = (word: string, r: number) => {
    const a = analyzeItalianWord(word);
    if (!a.rhymeKey) return;
    const e: Entry = { word, rank: r, key: a.rhymeKey, vowels: a.vowelTail, syllables: a.syllables };
    (byKey.get(e.key) ?? byKey.set(e.key, []).get(e.key)!).push(e);
    (byVowels.get(e.vowels) ?? byVowels.set(e.vowels, []).get(e.vowels)!).push(e);
  };
  list.forEach((raw, r) => {
    if (rank.get(raw) !== r) return;
    const accented = oxyPlain.get(raw);
    if (accented) return add(accented, r);
    if (!/^[a-z]+[aeiou]$/.test(raw) || isFragment(raw, r)) return;
    add(raw, r);
  });
  for (const [plain, accented] of oxyPlain) if (!rank.has(plain)) add(accented, list.length);
  italian = { byKey, byVowels };
  return italian;
}

function italianRhymes(input: string, limit: number): RhymeResult {
  const dict = loadItalian();
  const a = analyzeWord(input, "it");
  const self = input.toLowerCase();
  const perfect = (dict.byKey.get(a.rhymeKey) ?? [])
    .filter((e) => e.word !== self)
    .slice(0, limit)
    .map(({ word, syllables }) => ({ word, syllables }));
  const perfectSet = new Set(perfect.map((p) => p.word));
  // near rhymes: same vowels (assonance), preferring the same final consonant sounds
  const tailCons = a.rhymeKey.replace(/[aeiou]/g, "").slice(-1);
  const near = (dict.byVowels.get(a.vowelTail) ?? [])
    .filter((e) => e.word !== self && e.key !== a.rhymeKey && !perfectSet.has(e.word))
    .map((e) => ({ e, s: e.rank + (e.key.replace(/[aeiou]/g, "").slice(-1) === tailCons ? 0 : 20000) }))
    .sort((x, y) => x.s - y.s)
    .slice(0, limit)
    .map(({ e }) => ({ word: e.word, syllables: e.syllables }));
  return { word: input, rhymeKey: a.rhymeKey, perfect, near, source: "VerseFlow Italian rhyme index" };
}

async function datamuse(input: string, limit: number): Promise<RhymeResult> {
  const q = encodeURIComponent(input);
  const get = async (rel: string) => {
    const r = await fetch(`https://api.datamuse.com/words?${rel}=${q}&max=${limit}&md=s`, { next: { revalidate: 86400 } });
    if (!r.ok) return [] as RhymeWord[];
    const data = (await r.json()) as { word: string; numSyllables?: number }[];
    return data.map((d) => ({ word: d.word, syllables: d.numSyllables ?? 0 }));
  };
  const [perfect, near] = await Promise.all([get("rel_rhy"), get("rel_nry")]);
  return { word: input, rhymeKey: analyzeWord(input, "en").rhymeKey, perfect, near, source: "Datamuse" };
}

export async function findRhymes(text: string, lang: string, limit = 80): Promise<RhymeResult> {
  const word = lastWord(text).toLowerCase();
  if (!word) return { word: "", rhymeKey: "", perfect: [], near: [], source: "" };
  if (lang === "en") {
    try {
      return await datamuse(word, limit);
    } catch {
      return { word, rhymeKey: "", perfect: [], near: [], source: "Datamuse (unavailable)" };
    }
  }
  // Italian index; other Romance languages fall back to it for now
  return italianRhymes(word, limit);
}

/** Make the dictionary's oxytone knowledge available to line analysis on the server. */
export function warmItalian() {
  loadItalian();
}
