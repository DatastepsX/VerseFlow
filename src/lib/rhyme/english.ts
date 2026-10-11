/**
 * Heuristic English phonology. English spelling is irregular, so this is an
 * approximation good enough for live feedback while writing; the rhyme
 * dictionary for English uses Datamuse (pronunciation-based) instead.
 */

import type { WordPhonology } from "./types";

const V = "aeiouy";

// Unstressed endings: the rhyme starts at the syllable before them.
const WEAK_ENDINGS = /(ing|er|ers|ed|es|ly|le|les|y|ies|ness|less|ful|tion|tions|sion|sions|est|en|ens|ow|ows)$/;

// Spelling → sound normalisation applied to the rhyme part.
const SOUND_RULES: [RegExp, string][] = [
  [/ough$/, "O"],
  [/ight/g, "It"],
  [/igh/g, "I"],
  [/eigh/g, "A"],
  [/tion/g, "Sn"],
  [/sion/g, "Zn"],
  [/(ee|ea|ie)/g, "E"],
  [/(ai|ay|ey|ei)/g, "A"],
  [/(oa|oe)/g, "O"],
  [/(oo|ew|ue)/g, "U"],
  [/(ou|ow)/g, "W"],
  [/(oi|oy)/g, "Y"],
  [/ph/g, "f"],
  [/ck/g, "k"],
  [/c(?=[eiy])/g, "s"],
  [/c/g, "k"],
  [/q/g, "k"],
  [/wh/g, "w"],
  [/kn/g, "n"],
  [/wr/g, "r"],
  [/mb$/, "m"],
  [/([bcdfgklmnprstvz])\1/g, "$1"],
];

export function englishSyllables(w: string): number {
  let word = w.toLowerCase().replace(/[^a-z]/g, "");
  if (!word) return 0;
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "");
  word = word.replace(/^y/, "");
  const groups = word.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

function longVowel(v: string): string {
  return { a: "A", e: "E", i: "I", o: "O", u: "U", y: "I" }[v] ?? v;
}

export function analyzeEnglishWord(raw: string): WordPhonology {
  const word = raw.toLowerCase().replace(/[^a-z']/g, "").replace(/'/g, "");
  const syllables = englishSyllables(word);
  let core = word;
  let suffix = "";
  if (syllables > 1) {
    const m = word.match(WEAK_ENDINGS);
    if (m && word.length - m[0].length >= 2) {
      suffix = m[0];
      core = word.slice(0, -m[0].length);
    }
  }
  // final silent e makes the previous vowel long: "time" → tIm
  let tail = core;
  const magic = tail.match(/([aeiouy])([^aeiouy]{1})e$/);
  // locate last vowel group in the core
  const groups = [...tail.matchAll(/[aeiouy]+/g)];
  let start = 0;
  if (groups.length) {
    let g = groups[groups.length - 1];
    if (magic && groups.length >= 2 && g[0] === "e" && g.index === tail.length - 1) {
      g = groups[groups.length - 2];
    }
    start = g.index ?? 0;
  }
  tail = tail.slice(start);
  if (magic && tail.endsWith("e") && tail.length >= 3) {
    tail = longVowel(tail[0]) + tail.slice(1, -1);
  } else if (syllables === 1 && /^[^aeiouy]*[aeiou]$/.test(word) && tail.length === 1) {
    tail = longVowel(tail); // "me", "go", "so"
  } else if (/^y$/.test(tail) || (syllables === 1 && /^y$|^ye$/.test(tail))) {
    tail = "I";
  }
  let key = tail + suffix;
  for (const [re, rep] of SOUND_RULES) key = key.replace(re, rep);
  // y at the end of a multi-syllable word sounds like "ee"
  if (syllables > 1 && key.endsWith("y")) key = key.slice(0, -1) + "E";
  const vowelTail = (key.match(/[aeiouAEIOUWY]/g) ?? []).join("");
  return {
    word: raw,
    phonemes: key,
    syllables,
    stressFromEnd: suffix ? 1 : 0,
    rhymeKey: key,
    vowelTail,
    vowels: vowelTail,
    startsWithVowel: V.includes(word[0] ?? ""),
    endsWithVowel: V.includes(word[word.length - 1] ?? ""),
  };
}
