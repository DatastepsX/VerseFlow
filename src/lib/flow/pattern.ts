import { prosody } from "@/lib/rhyme/prosody";
import { syllableParts } from "@/lib/rhyme/syllabify";
import type { FlowPattern, LineFlow, PatternLine } from "@/lib/types";
import { exampleWords } from "./example";

/**
 * Flow patterns: 2 or 4 lines that set the flow of a part (or a stretch of
 * it). A pattern line is made by writing it (its words → syllables; each
 * syllable can be stressed, long, or followed by a pause) or by singing /
 * tapping it over the beat (where each syllable starts). Applied to a part,
 * the pattern repeats line after line, one per bar.
 *
 * Pure TypeScript: on the phone and in tests.
 */

/** the chips of a line: one per syllable, with its letters when the line can be split */
export function chipsOf(text: string, lang: string): string[] {
  const parts = syllableParts(text, lang);
  if (parts) return parts.map((p) => p.text);
  const n = prosody(text, lang).syllables;
  return Array.from({ length: n }, () => "•");
}

/** a written line → a pattern line: its syllables, natural stresses, a pause at a comma */
export function lineFromText(text: string, lang: string, bar: number, keep?: PatternLine): PatternLine {
  const parts = syllableParts(text, lang);
  const n = parts ? parts.length : prosody(text, lang).syllables;
  const sameCount = keep && keep.syllables === n;
  const natural = prosody(text, lang).stresses.map((s) => s + 1);
  const pauses = parts ? parts.map((p, i) => (/[,;:.!?…—–-]$/.test(p.text.trim()) && i < parts.length - 1 ? i + 1 : 0)).filter(Boolean) : [];
  const line: PatternLine = {
    text,
    written: true,
    syllables: n,
    // the same number of syllables: what was set (stresses, long notes, pauses, timing) stays
    stress: sameCount ? keep.stress : natural,
    long: sameCount ? keep.long : n ? [n] : [],
    pauses: sameCount ? keep.pauses : pauses,
    offsets: [],
  };
  line.offsets = sameCount && keep.offsets.length === n ? keep.offsets : layoutOffsets(line, bar);
  return line;
}

/**
 * Where the syllables of a written line fall in its bar: an 8th note each
 * (a long one two), a pause an 8th; squeezed when the line is longer than
 * the bar.
 */
export function layoutOffsets(line: Pick<PatternLine, "syllables" | "long" | "pauses">, bar: number): number[] {
  const long = new Set(line.long);
  const pauses = new Set(line.pauses);
  const units: number[] = [];
  let total = 0;
  for (let k = 1; k <= line.syllables; k++) {
    units.push(total);
    total += (long.has(k) && k < line.syllables ? 2 : 1) + (pauses.has(k) ? 1 : 0);
  }
  const unit = Math.min(bar / 8, bar / Math.max(1, total));
  return units.map((u) => round(u * unit));
}

/** a changed chip (stress, long note, pause): the timing follows (written lines are laid out again) */
export function relayout(line: PatternLine, bar: number): PatternLine {
  return { ...line, offsets: layoutOffsets(line, bar) };
}

/**
 * Sung or tapped bars → pattern lines: one line per bar, a syllable per
 * onset (song time), stressed when it lands on a beat or was sung louder,
 * long when the next one is a quarter or more later. Example words show the
 * length until the writer types their own.
 */
export function linesFromOnsets(
  onsets: { t: number; strength?: number | null }[],
  from: number,
  bar: number,
  bars: number,
  lang: string,
  seed = 0,
): PatternLine[] {
  const beat = bar / 4;
  return Array.from({ length: bars }, (_, b) => {
    const start = from + b * bar;
    const inBar = onsets.filter((o) => o.t >= start - beat / 4 && o.t < start + bar - beat / 4).sort((x, y) => x.t - y.t);
    const offsets = inBar.map((o) => round(Math.max(0, o.t - start)));
    const top = Math.max(0, ...inBar.map((o) => o.strength ?? 0));
    const stress = inBar
      .map((o, i) => {
        const onBeat = Math.abs(offsets[i] / beat - Math.round(offsets[i] / beat)) < 0.15;
        const loud = o.strength !== undefined && o.strength !== null && top > 0 ? o.strength / top >= 0.75 : false;
        return onBeat || loud ? i + 1 : 0;
      })
      .filter(Boolean);
    const long = offsets.map((t, i) => ((offsets[i + 1] ?? bar) - t >= beat * 0.95 ? i + 1 : 0)).filter(Boolean);
    const n = inBar.length;
    return {
      text: n ? exampleWords(n, stress, lang, seed + b) : "",
      written: false,
      syllables: n,
      stress,
      long,
      pauses: [],
      offsets,
    };
  });
}

/** how many bars one pattern line takes (most lines: one) */
export function barsPerLine(pattern: FlowPattern): number {
  const longest = Math.max(0, ...pattern.lines.map((l) => (l.offsets.length ? l.offsets[l.offsets.length - 1] : 0)));
  return Math.max(1, Math.ceil((longest + 0.05) / pattern.bar - 0.02));
}

/** line i of a part following the pattern: its flow, starting at the given bar line */
export function lineFlowFrom(pattern: FlowPattern, i: number, barStart: number, bar: number, flowId: string): LineFlow {
  const p = pattern.lines.length;
  const k = i % p;
  const pl = pattern.lines[k];
  const scale = bar / pattern.bar;
  const times = pl.offsets.map((o) => round(barStart + o * scale));
  const last = times[times.length - 1] ?? barStart;
  const held = pl.long.includes(pl.syllables);
  // couplets: 2 lines → 1+2; 4 lines AABB → 1+2, 3+4 (ABAB pairs 1+3 and 2+4 by patternLine)
  const pair = pattern.scheme === "ABAB" && p === 4 ? undefined : ((k % 2) + 1) as 1 | 2;
  return {
    syllables: pl.syllables,
    stress: pl.stress,
    held,
    words: "",
    source: "flow",
    times,
    end: round(last + (held ? bar / 4 : bar / 8) * 1),
    pair,
    flowId,
    patternLine: k,
    scheme: pattern.scheme,
  };
}

/** "Flow A", "Flow B"… the next free name */
export function nextFlowName(taken: string[]): string {
  for (let i = 0; ; i++) {
    const letters = i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));
    const name = `Flow ${letters}`;
    if (!taken.includes(name)) return name;
  }
}

const round = (t: number) => Math.round(t * 1000) / 1000;
