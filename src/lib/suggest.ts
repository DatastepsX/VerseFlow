/**
 * Serves next-bar suggestions from a section's pre-generated bank, locally.
 * Matching uses the rhyme engine (not the AI's labels): a slot that must rhyme
 * with a partner line only gets perfect rhymes or assonances; an opening slot
 * prefers lines whose family still has partners left, so the next bar can be
 * served from the bank too.
 */
import { analyzeLine, compareLines, type RhymeQuality } from "./rhyme/analyze";
import { rhymePartners } from "./scheme";
import type { BankLine } from "./types";

export interface BankSuggestion {
  line: BankLine;
  score: number;
  quality: RhymeQuality | "opener";
  syllables: number;
}

export interface SlotSuggestions {
  suggestions: BankSuggestion[];
  /** text of the line this slot must rhyme with, if any */
  partnerText: string | null;
  /** how many bank lines would fit this slot in total */
  matches: number;
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
}): SlotSuggestions {
  const { bank, texts, index, groupSize, scheme, lang } = opts;
  const count = opts.count ?? 3;
  const slotTexts = index < texts.length ? texts.map((t, i) => (i === index ? "" : t)) : [...texts, ""];
  const p = rhymePartners(slotTexts, groupSize, scheme)[index]?.partner ?? null;
  const partnerText = p !== null && slotTexts[p]?.trim() ? slotTexts[p] : null;
  const pa = partnerText ? analyzeLine(partnerText, lang) : null;

  const others = slotTexts.filter((t) => t.trim());
  const sylTarget = others.length ? others.reduce((n, t) => n + analyzeLine(t, lang).syllables, 0) / others.length : null;
  const inSong = new Set(texts.map((t) => t.trim().toLowerCase()));

  const available = bank.filter((b) => b.state === "available" && !inSong.has(b.text.trim().toLowerCase()));
  const perFamily = new Map<string, number>();
  for (const b of available) perFamily.set(b.family, (perFamily.get(b.family) ?? 0) + 1);
  // the bank line the partner came from, if any → its couplet sibling fits best
  const partnerOrigin = partnerText ? bank.find((b) => b.state === "used" && b.text.trim() === partnerText.trim()) : undefined;

  const scored: BankSuggestion[] = [];
  for (const b of available) {
    const a = analyzeLine(b.text, lang);
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
    if (sylTarget) score -= Math.min(0.3, Math.abs(a.syllables - sylTarget) * 0.04);
    scored.push({ line: b, score, quality, syllables: a.syllables });
  }
  scored.sort((x, y) => y.score - x.score);

  // variety: openers come from different families
  const picked: BankSuggestion[] = [];
  const seen = new Map<string, number>();
  const maxPerFamily = pa ? 3 : 1;
  for (const s of scored) {
    const n = seen.get(s.line.family) ?? 0;
    if (n >= maxPerFamily) continue;
    seen.set(s.line.family, n + 1);
    picked.push(s);
  }
  const skip = picked.length ? (opts.skip ?? 0) % Math.max(1, picked.length) : 0;
  const rotated = [...picked.slice(skip), ...picked.slice(0, skip)];
  return { suggestions: rotated.slice(0, count), partnerText, matches: picked.length };
}
