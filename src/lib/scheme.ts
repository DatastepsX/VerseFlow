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

export function rhymePartners(texts: string[], groupSize: number, scheme: string | null | undefined): Partner[] {
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
