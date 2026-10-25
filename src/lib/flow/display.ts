import { prosody } from "@/lib/rhyme/prosody";
import { syllableParts, type SyllablePart } from "@/lib/rhyme/syllabify";
import type { LineFlow } from "@/lib/types";

/**
 * A line as its flow reads: the word groups sung together (a break between them), the stressed syllables and
 * the long ones. The breaks come from the flow (where it pauses, or where its syllables are far apart) and
 * from the text's own commas; a break always falls between words. Pure: the Lyrics and Record screens draw it.
 */

export interface FlowSyllable extends SyllablePart {
  /** index in the line's syllables */
  i: number;
  stressed: boolean;
  /** held (a long note) */
  long: boolean;
}

export interface FlowGroup {
  syllables: FlowSyllable[];
}

const PUNCT_END = /[,;:.!?…—–]["»”’)]*$/;

export function flowGroups(text: string, lang: string, flow: LineFlow | null | undefined, beat?: number): FlowGroup[] | null {
  const parts = syllableParts(text, lang);
  if (!parts || !parts.length) return null;
  const n = parts.length;
  const stressed = new Set(prosody(text, lang).stresses);
  // syllable k of the flow → syllable of this text (written with a syllable more or less: in proportion)
  const fs = flow?.syllables ?? 0;
  const map = (k: number) => (fs > 0 && fs !== n ? Math.round((k * n) / fs) : k);

  // where a word group ends: after syllable i (0-based) — never inside a word
  const breaks = new Set<number>();
  const wordEndNear = (i: number) => {
    for (const d of [0, 1, -1]) {
      const j = i + d;
      if (j >= 0 && j < n - 1 && parts[j + 1].space) return j;
    }
    return -1;
  };
  // a pause right after a syllable merged across two words ("notte io" → "te io"): sung apart, so it splits there
  const splitAt = new Set<number>();
  for (const k of flow?.pauses ?? []) {
    const at = map(k) - 1;
    if (at >= 0 && at < n && parts[at].text.trim().includes(" ")) {
      splitAt.add(at);
      continue;
    }
    const j = wordEndNear(at);
    if (j >= 0) breaks.add(j);
  }
  // the flow's own timing: a gap clearly longer than the line's pace
  const t = flow?.times;
  if (t && t.length === n && n > 2) {
    const gaps = t.slice(1).map((x, i) => x - t[i]);
    const typical = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    gaps.forEach((g, i) => {
      if (g >= Math.max(1.8 * typical, typical + 0.15, (beat ?? 0) * 0.6) && parts[i + 1].space) breaks.add(i);
    });
  }
  // the text's commas and full stops inside the line
  parts.forEach((p, i) => {
    if (i < n - 1 && PUNCT_END.test(p.text.trim()) && parts[i + 1].space) breaks.add(i);
  });

  // long notes: as the flow holds them, or (timed) a syllable a beat or more before the next that isn't a break
  const long = new Set<number>();
  for (const k of flow?.long ?? []) if (k >= 1) long.add(Math.min(n - 1, map(k) - 1));
  if (flow?.held) long.add(n - 1);
  if (t && t.length === n && beat) t.forEach((x, i) => i < n - 1 && t[i + 1] - x >= 0.95 * beat && !breaks.has(i) && long.add(i));

  const groups: FlowGroup[] = [{ syllables: [] }];
  parts.forEach((p, i) => {
    const s = { ...p, i, stressed: stressed.has(i), long: long.has(i) };
    if (splitAt.has(i)) {
      // "te io": "te" ends the group, "io" starts the next (both halves are syllable i)
      const cut = p.text.lastIndexOf(" ");
      groups[groups.length - 1].syllables.push({ ...s, text: p.text.slice(0, cut), long: false });
      groups.push({ syllables: [{ ...s, text: p.text.slice(cut + 1), space: true, stressed: false }] });
    } else groups[groups.length - 1].syllables.push(s);
    if (breaks.has(i)) groups.push({ syllables: [] });
  });
  return groups.filter((g) => g.syllables.length);
}
