/**
 * Make a line a little longer or shorter by adding or removing filler words,
 * so it fits the length and flow of a reference line — locally, no AI call.
 *
 * Every candidate edit (insert one filler at one position, or drop one
 * removable word) is scored by how close it lands to the requested step and
 * to the reference rhythm; the last word is never touched (keeps the rhyme).
 */
import { tokenize } from "./analyze";
import { prosody, rhythmSimilarity, type Prosody } from "./prosody";

interface Fillers {
  /** words that can open a line ("E", "Ma"…), most natural first */
  lead: string[];
  /** words that can sit inside a line */
  inner: string[];
  /** words that may be dropped to shorten a line */
  removable: string[];
}

const FILLERS: Record<string, Fillers> = {
  it: {
    lead: ["e", "ma", "sì", "poi", "già", "ora", "io", "tu", "sai", "e poi", "ma sì", "adesso"],
    inner: ["già", "poi", "sempre", "ancora", "proprio", "solo", "così", "anche", "ormai", "davvero", "adesso"],
    removable: [
      "e", "ma", "poi", "già", "più", "sì", "proprio", "solo", "così", "ancora", "sempre", "anche", "ormai", "davvero",
      "adesso", "ora", "tutto", "molto", "tanto", "quasi", "ancor", "io", "tu", "eh", "oh", "sai",
    ],
  },
  en: {
    lead: ["and", "but", "so", "yeah", "now", "oh", "just", "and now"],
    inner: ["just", "still", "so", "all", "now", "really", "even", "always", "never"],
    removable: ["and", "but", "so", "yeah", "now", "oh", "just", "still", "really", "even", "all", "very", "always"],
  },
  es: {
    lead: ["y", "pero", "sí", "ya", "pues", "ahora"],
    inner: ["ya", "más", "tan", "solo", "aún", "siempre", "también", "ahora"],
    removable: ["y", "pero", "ya", "más", "tan", "solo", "aún", "siempre", "también", "ahora", "pues", "sí"],
  },
};

// Words that bind to the next word: nothing may be inserted right after them
// ("ti | cerco", "nel | buio", "the | night").
const BINDS_NEXT: Record<string, Set<string>> = {
  it: new Set(
    "che e ed ma o se ti mi si ci vi ne lo la li il i gli le l un uno una un' di a da in con su per tra fra del dello della dei degli delle al allo alla ai agli alle dal dalla dai dalle nel nello nella nei negli nelle sul sulla sui sulle col non mio mia tuo tua suo sua quel quella questo questa ogni".split(" "),
  ),
  en: new Set("the a an my your his her our their this that to of in on at by for from with into not no".split(" ")),
  es: new Set("el la los las un una de a en con por para del al mi tu su no me te se lo le nos".split(" ")),
};
// Natural landing spots: a filler right before one of these reads well
// ("ti cerco | già | nel buio", "ma | ancora | che").
const GOOD_BEFORE: Record<string, Set<string>> = {
  it: new Set("nel nella nei negli nelle con per di da a in su come quando non mi ti ci si".split(" ")),
  en: new Set("in on at to with when like and but that".split(" ")),
  es: new Set("en con por para de que como cuando y pero".split(" ")),
};
const PRONOUNS_EN = new Set("i you we they he she it".split(" "));

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lowerFirst = (s: string) => (s && !/^I\b/.test(s) && s[0] !== s[0].toLowerCase() && s.slice(1, 2) === s.slice(1, 2).toLowerCase() ? s[0].toLowerCase() + s.slice(1) : s);

/** Raw word spans so we can edit without losing punctuation. */
function spans(text: string) {
  const out: { start: number; end: number; word: string }[] = [];
  const re = /[\p{L}'’]+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
  return out;
}

function candidates(text: string, lang: string, dir: 1 | -1): { text: string; rank: number }[] {
  const f = FILLERS[lang] ?? FILLERS.it;
  const ws = spans(text);
  if (!ws.length) return [];
  const lower = ws.map((w) => w.word.toLowerCase());
  const present = new Set(lower);
  const fillerWords = new Set([...f.lead, ...f.inner, ...f.removable].flatMap((x) => x.split(" ")));
  // a filler right before a conjunction would dangle at the end of the clause ("buio poi | che")
  const clauseStart = new Set(["che", "e", "ed", "ma", "o", "and", "but", "or", "that", "y", "pero", "que"]);
  const out: { text: string; rank: number }[] = [];
  if (dir === 1) {
    // a filler at the start of the line — not when it already opens with one
    if (!fillerWords.has(lower[0])) {
      f.lead.forEach((fill, i) => {
        if (fill.split(" ").some((x) => present.has(x))) return;
        out.push({ text: `${capitalize(fill)} ${lowerFirst(text.trimStart())}`, rank: i * 0.5 });
      });
    }
    // a filler between two words: never twice in a line, never next to another filler,
    // never after a word that binds to the next one (the rhyme word itself always stays)
    const binds = BINDS_NEXT[lang] ?? BINDS_NEXT.it;
    const good = GOOD_BEFORE[lang] ?? GOOD_BEFORE.it;
    for (let k = 1; k < ws.length; k++) {
      const prev = lower[k - 1].replace(/[’']$/, "'");
      if (fillerWords.has(prev) || fillerWords.has(lower[k]) || binds.has(prev) || clauseStart.has(lower[k]) || /['’]$/.test(lower[k - 1])) continue;
      if (lang === "en" && !PRONOUNS_EN.has(prev)) continue; // English: "I just keep…", "you still know…"
      const spot = good.has(lower[k]) ? 0 : 1.2;
      f.inner.forEach((fill, i) => {
        if (present.has(fill)) return;
        out.push({ text: `${text.slice(0, ws[k].start)}${fill} ${text.slice(ws[k].start)}`, rank: 1 + spot + i * 0.4 + k * 0.05 });
      });
    }
  } else {
    // poetic truncation, common in Italian lyrics: "sono"→"son", "pensare"→"pensar", "cuore"→"cuor"
    if (lang === "it") {
      for (let k = 0; k < ws.length - 1; k++) {
        const w = ws[k].word;
        if (w.length < 4 || !/[lnr][eo]$/i.test(w) || /[aeiou]$/i.test(lower[k + 1]?.[0] ?? "")) continue;
        out.push({ text: text.slice(0, ws[k].start) + w.slice(0, -1) + text.slice(ws[k].end), rank: 0.8 + k * 0.05 });
      }
    }
    for (let k = 0; k < ws.length - 1; k++) {
      const idx = f.removable.indexOf(lower[k]);
      if (idx < 0) continue;
      const before = text.slice(0, ws[k].start);
      let after = text.slice(ws[k].end).replace(/^[\s,]+/, "");
      if (k === 0) after = capitalize(after);
      out.push({ text: (before + after).replace(/\s{2,}/g, " ").trim(), rank: idx * 0.3 + (k === 0 ? 0 : 0.5) });
    }
  }
  return out;
}

/**
 * One small step longer (dir = 1) or shorter (dir = -1).
 * Returns the edited line, or null when nothing sensible is possible.
 */
export function adjustLength(text: string, lang: string, dir: 1 | -1, reference?: Prosody | null): string | null {
  if (!tokenize(text).length) return null;
  const cur = prosody(text, lang).syllables;
  let best: { text: string; score: number } | null = null;
  for (const c of candidates(text, lang, dir)) {
    const p = prosody(c.text, lang);
    const delta = (p.syllables - cur) * dir;
    if (delta < 1 || delta > 3) continue; // must move in the asked direction, in a small step
    let score = (delta - 1) * 1.2 + c.rank * 0.15; // smallest step, most natural filler
    if (reference) {
      // prefer edits that bring the line onto the reference's length and stresses
      score -= rhythmSimilarity(reference, p) * 2;
      score += Math.abs(p.syllables - reference.syllables) * 0.3;
    }
    if (!best || score < best.score) best = { text: c.text, score };
  }
  return best?.text ?? null;
}
