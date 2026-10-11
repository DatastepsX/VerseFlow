/**
 * Serves next-bar suggestions from a section's pre-generated bank, locally.
 * Matching uses the rhyme engine (not the AI's labels): a slot that must rhyme
 * with a partner line only gets perfect rhymes or assonances; an opening slot
 * prefers lines whose family still has partners left, so the next bar can be
 * served from the bank too.
 */
import { analyzeLine, compareLines, type RhymeQuality } from "./rhyme/analyze";
import { prosody, rhythmSimilarity, type Prosody } from "./rhyme/prosody";
import { rhymePartners } from "./scheme";
import type { BankLine } from "./types";

export interface BankSuggestion {
  line: BankLine;
  score: number;
  quality: RhymeQuality | "opener";
  syllables: number;
  /** 0..1 rhythm match with the reference line (length, stresses, ending) */
  rhythm: number;
  /** syllables minus the reference line's syllables */
  sylDiff: number;
}

export interface SlotSuggestions {
  suggestions: BankSuggestion[];
  /** text of the line this slot must rhyme with, if any */
  partnerText: string | null;
  /** how many bank lines would fit this slot in total */
  matches: number;
  /** the line whose length and flow the suggestions follow */
  reference: { text: string; prosody: Prosody } | null;
}

/**
 * The rhythm reference for a slot: a section line marked as rhythm reference
 * wins, otherwise the closest written line before the slot.
 */
export function rhythmReference(texts: string[], index: number, rhythmRef?: string | null) {
  if (rhythmRef?.trim()) return rhythmRef;
  for (let i = Math.min(index, texts.length) - 1; i >= 0; i--) if (texts[i]?.trim()) return texts[i];
  for (let i = index + 1; i < texts.length; i++) if (texts[i]?.trim()) return texts[i];
  return null;
}

export function suggestForSlot(opts: {
  bank: BankLine[];
  texts: string[];
  index: number;
  groupSize: number;
  scheme: string | null;
  lang: string;
  count?: number;
  skip?: number;
  /** text of a line marked as rhythm reference in this section */
  rhythmRef?: string | null;
  /** the slot's section: its own bank lines rank first, other sections' bars are reused too */
  sectionId?: string;
}): SlotSuggestions {
  const { bank, texts, index, groupSize, scheme, lang } = opts;
  const count = opts.count ?? 3;
  const slotTexts = index < texts.length ? texts.map((t, i) => (i === index ? "" : t)) : [...texts, ""];
  const p = rhymePartners(slotTexts, groupSize, scheme, lang)[index]?.partner ?? null;
  const partnerText = p !== null && slotTexts[p]?.trim() ? slotTexts[p] : null;
  const pa = partnerText ? analyzeLine(partnerText, lang) : null;

  const refText = rhythmReference(slotTexts, index, opts.rhythmRef);
  const ref = refText ? prosody(refText, lang) : null;
  const inSong = new Set(texts.map((t) => t.trim().toLowerCase()));

  const available = bank.filter((b) => b.state === "available" && !inSong.has(b.text.trim().toLowerCase()));
  const perFamily = new Map<string, number>();
  for (const b of available) perFamily.set(b.family, (perFamily.get(b.family) ?? 0) + 1);
  // the bank line the partner came from, if any → its couplet sibling fits best
  const partnerOrigin = partnerText ? bank.find((b) => b.state === "used" && b.text.trim() === partnerText.trim()) : undefined;

  const scored: BankSuggestion[] = [];
  for (const b of available) {
    const a = analyzeLine(b.text, lang);
    const pr = prosody(b.text, lang);
    const rhythm = ref ? rhythmSimilarity(ref, pr) : 0.5;
    const sylDiff = ref ? pr.syllables - ref.syllables : 0;
    let score: number;
    let quality: BankSuggestion["quality"];
    if (pa) {
      const m = compareLines(a, pa);
      if (m.quality === "perfect") score = 1;
      else if (m.quality === "assonance") score = 0.6;
      else continue;
      quality = m.quality;
      if (partnerOrigin && partnerOrigin.family === b.family) {
        score += 0.2;
        if ((partnerOrigin.family_pos ^ 1) === b.family_pos) score += 0.3; // written as its couplet
      }
    } else {
      quality = "opener";
      score = 0.7;
      if ((perFamily.get(b.family) ?? 0) < 2) score -= 0.4; // nothing left to rhyme with it
      if (b.family_pos % 2 === 0) score += 0.1; // written as a couplet opener
    }
    // flow of the line before matters as much as the rhyme
    score += 0.8 * rhythm;
    // bars written for this section fit its story best; other sections' bars are reused after them
    if (opts.sectionId && b.section_id === opts.sectionId) score += 0.15;
    scored.push({ line: b, score, quality, syllables: pr.syllables, rhythm, sylDiff });
  }
  scored.sort((x, y) => y.score - x.score);
  // bars far off in length (> 2 syllables) only show up when nothing closer exists
  const close = scored.filter((x) => Math.abs(x.sylDiff) <= 2);
  const pool = ref && close.length >= Math.min(count, scored.length) ? close : scored;

  // variety: openers come from different families
  const picked: BankSuggestion[] = [];
  const seen = new Map<string, number>();
  const maxPerFamily = pa ? 3 : 1;
  for (const s of pool) {
    const n = seen.get(s.line.family) ?? 0;
    if (n >= maxPerFamily) continue;
    seen.set(s.line.family, n + 1);
    picked.push(s);
  }
  const skip = picked.length ? (opts.skip ?? 0) % Math.max(1, picked.length) : 0;
  const rotated = [...picked.slice(skip), ...picked.slice(0, skip)];
  return {
    suggestions: rotated.slice(0, count),
    partnerText,
    matches: picked.length,
    reference: refText && ref ? { text: refText, prosody: ref } : null,
  };
}

export interface CoupletSuggestion {
  first: BankLine;
  second: BankLine;
  /** average rhythm match of both lines with the reference */
  rhythm: number;
  syllables: [number, number];
}

/**
 * Whole couplets for a slot that opens a new couplet: pairs written together
 * (family positions 0-1, 2-3, …) whose lines are both still available, ranked
 * by how well both follow the reference flow; the section's own bars first.
 */
export function coupletsForSlot(opts: {
  bank: BankLine[];
  texts: string[];
  index: number;
  lang: string;
  sectionId?: string;
  rhythmRef?: string | null;
  count?: number;
  skip?: number;
}): { couplets: CoupletSuggestion[]; total: number } {
  const { bank, texts, index, lang } = opts;
  const refText = rhythmReference(texts, index, opts.rhythmRef);
  const ref = refText ? prosody(refText, lang) : null;
  const inSong = new Set(texts.map((t) => t.trim().toLowerCase()));
  const byFamily = new Map<string, BankLine[]>();
  for (const b of bank) {
    if (b.state !== "available" || inSong.has(b.text.trim().toLowerCase())) continue;
    (byFamily.get(b.family) ?? byFamily.set(b.family, []).get(b.family)!).push(b);
  }
  const scored: (CoupletSuggestion & { score: number })[] = [];
  for (const lines of byFamily.values()) {
    const byPos = new Map(lines.map((l) => [l.family_pos, l]));
    for (const l of lines) {
      if (l.family_pos % 2 !== 0) continue;
      const partner = byPos.get(l.family_pos + 1);
      if (!partner) continue;
      const p1 = prosody(l.text, lang);
      const p2 = prosody(partner.text, lang);
      const rhythm = ref ? (rhythmSimilarity(ref, p1) + rhythmSimilarity(ref, p2)) / 2 : 0.5;
      const own = opts.sectionId && l.section_id === opts.sectionId ? 0.15 : 0;
      scored.push({ first: l, second: partner, rhythm, syllables: [p1.syllables, p2.syllables], score: rhythm + own });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const count = opts.count ?? 3;
  const skip = scored.length ? (opts.skip ?? 0) % scored.length : 0;
  const rotated = [...scored.slice(skip), ...scored.slice(0, skip)];
  return { couplets: rotated.slice(0, count), total: scored.length };
}
