import { analyzeLine, compareLines, type LineAnalysis } from "./rhyme/analyze";

/**
 * Intended rhyme structure of a section: which line each line should rhyme
 * with, from the section's rhyme scheme ("AABB", "ABAB", "AA BB"…) or a
 * default derived from the grouping (couplets → AA, quatrains → AABB).
 */
export function schemePattern(groupSize: number, scheme: string | null | undefined): string {
  const s = (scheme ?? "").toUpperCase().replace(/[^A-Z-]/g, "");
  if (s) return s;
  if (groupSize === 2) return "AA";
  if (groupSize === 4) return "AABB";
  if (groupSize === 3) return "AAB";
  return "-";
}

export interface Partner {
  /** expected rhyme letter for this line, or null when no rhyme is expected */
  letter: string | null;
  /** index of the line this one should rhyme with */
  partner: number | null;
}

/**
 * Rhyme partners as the text is actually written: lines that rhyme are paired
 * (nearest first, up to 3 lines apart); the usual distance (couplets = 1,
 * alternating = 2) then pairs the lines that don't rhyme yet — e.g. the line
 * being rewritten gets the partner the pattern implies. Empty / unknown lines
 * ("" or "x") are paired the same way. null when the text shows no pattern
 * (fewer than 2 rhyming pairs).
 */
export function inferPartners(texts: string[], lang: string, songDistance?: 1 | 2 | null, minPairs = 2): Partner[] | null {
  const n = texts.length;
  const a: (LineAnalysis | null)[] = texts.map((t) => (t.trim() && t !== "x" ? analyzeLine(t, lang) : null));
  const rhymes = (i: number, j: number) => {
    const x = a[i];
    const y = a[j];
    if (!x || !y) return false;
    const m = compareLines(x, y);
    return m.quality !== "none" && m.score >= 0.45;
  };
  const partner: (number | null)[] = new Array(n).fill(null);
  const dist: number[] = [];
  for (let i = 0; i < n; i++) {
    if (partner[i] !== null || !a[i]) continue;
    for (let d = 1; d <= 3 && i + d < n; d++) {
      const j = i + d;
      if (partner[j] === null && rhymes(i, j)) {
        partner[i] = j;
        partner[j] = i;
        dist.push(d);
        break;
      }
    }
  }
  // too little text to tell (a short section): the pattern of the whole song decides
  if (dist.length < minPairs && !songDistance) return null;
  const usual = dist.length >= minPairs ? (dist.filter((d) => d === 1).length >= dist.filter((d) => d === 2).length ? 1 : 2) : songDistance!;
  for (let i = 0; i < n; i++) {
    if (partner[i] !== null) continue;
    for (const j of [i + usual, i - usual]) {
      if (j >= 0 && j < n && partner[j] === null) {
        partner[i] = j;
        partner[j] = i;
        break;
      }
    }
  }
  return partner.map((p) => ({ letter: p === null ? null : "A", partner: p }));
}

/**
 * Which line each line should rhyme with. An explicit section scheme wins;
 * otherwise (with `lang`) the pattern the text actually follows, else the
 * default of the grouping.
 */
export function rhymePartners(
  texts: string[],
  groupSize: number,
  scheme: string | null | undefined,
  lang?: string,
  songDistance?: 1 | 2 | null,
): Partner[] {
  if (lang && !(scheme ?? "").trim()) {
    const inferred = inferPartners(texts, lang, songDistance);
    if (inferred) return inferred;
  }
  const pattern = schemePattern(groupSize, scheme);
  const n = pattern.length;
  return texts.map((_, i) => {
    const letter = pattern[i % n];
    if (!letter || letter === "-" || letter === "X") return { letter: null, partner: null };
    const blockStart = i - (i % n);
    const blockEnd = Math.min(texts.length, blockStart + n);
    for (let j = i - 1; j >= blockStart; j--) if (pattern[j % n] === letter) return { letter, partner: j };
    for (let j = i + 1; j < blockEnd; j++) if (pattern[j % n] === letter) return { letter, partner: j };
    return { letter, partner: null };
  });
}

/** how the whole song rhymes: 1 = couplets, 2 = alternating, null = no clear pattern */
export function songRhymeDistance(sections: string[][], lang: string): 1 | 2 | null {
  let one = 0;
  let two = 0;
  for (const texts of sections) {
    // every rhyming pair counts, also in sections of a single couplet
    const p = inferPartners(texts, lang, null, 1);
    if (!p) continue;
    p.forEach((x, i) => {
      if (x.partner === i + 1) one++;
      if (x.partner === i + 2) two++;
    });
  }
  if (one + two < 2) return null;
  return one >= two ? 1 : 2;
}
