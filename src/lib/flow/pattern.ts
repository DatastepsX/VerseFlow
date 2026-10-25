import { prosody } from "@/lib/rhyme/prosody";
import { syllableParts } from "@/lib/rhyme/syllabify";
import type { FlowPattern, LineFlow, PatternLine } from "@/lib/types";
import { exampleWords, isExampleText } from "./example";
import { alignTakeLines } from "./align";

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
export function chipsOf(text: string, lang: string, commaPauses = false): string[] {
  const parts = syllableParts(text, lang, commaPauses);
  if (parts) return parts.map((p) => p.text);
  const n = prosody(text, lang, commaPauses).syllables;
  return Array.from({ length: n }, () => "•");
}

/** a written line → a pattern line: its syllables, natural stresses, a pause at a comma */
export function lineFromText(text: string, lang: string, bar: number, keep?: PatternLine): PatternLine {
  const cp = !!keep?.commaPauses;
  const parts = syllableParts(text, lang, cp);
  const n = parts ? parts.length : prosody(text, lang, cp).syllables;
  const sameCount = keep && keep.syllables === n;
  const natural = prosody(text, lang, cp).stresses.map((s) => s + 1);
  const pauses = parts ? parts.map((p, i) => (/[,;:.!?…—–-]$/.test(p.text.trim()) && i < parts.length - 1 ? i + 1 : 0)).filter(Boolean) : [];
  const line: PatternLine = {
    text,
    written: true,
    ...(keep?.sung ? { sung: true } : {}),
    ...(cp ? { commaPauses: true } : {}),
    ...(keep?.at !== undefined ? { at: keep.at } : {}),
    syllables: n,
    // the same number of syllables: what was set (stresses, long notes, pauses, timing) stays
    stress: sameCount ? keep.stress : natural,
    long: sameCount ? keep.long : n ? [n] : [],
    pauses: sameCount ? keep.pauses : pauses,
    offsets: [],
  };
  line.offsets =
    sameCount && keep.offsets.length === n
      ? keep.offsets
      : keep?.sung && keep.offsets.length > 1 && n > 1
        ? spread(keep.offsets, n)
        : layoutOffsets(line, bar);
  return line;
}

/** a sung line typed with another count: the syllables share the time it was sung in */
function spread(offsets: number[], n: number): number[] {
  const first = offsets[0];
  const last = offsets[offsets.length - 1];
  return Array.from({ length: n }, (_, k) => round(first + ((last - first) * k) / (n - 1)));
}

/** sounds sung only for the rhythm: pa, pam, para, na na… */
const SCAT = /^(?:pa|pam|ra|ta|tam|da|dam|na|nan|la|ba|bam|du|dum|di|do|ye|yeah|eh|oh|uh|ah|hey|yo)+$/;

/**
 * The writer's own words: kept as the lyrics where the flow is first used. Not when the line only shows a
 * rhythm — "pa pam para" sounds, or (sung / tapped) the example words, even typed over to fix the count.
 */
export function ownWords(line: PatternLine, lang: string, source?: FlowPattern["source"]): boolean {
  const text = line.text.trim();
  if (!line.written || !text) return false;
  const ws = text
    .toLowerCase()
    .split(/[\s,.;:!?…'’-]+/)
    .filter(Boolean);
  if (ws.every((w) => SCAT.test(w))) return false;
  const sung = line.sung ?? (source !== undefined && source !== "write");
  return !(sung && isExampleText(text, lang));
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
  onsets: Onset[],
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
    return sungLine(inBar, start, bar, lang, seed + b);
  });
}

/**
 * Sung or tapped lines split where "Next line" was tapped (`firsts`: the
 * index of the first onset of each new line, in time order) instead of at
 * the bar lines: a line can be shorter or longer than a bar. Each line is
 * timed from the bar line it starts in (a little early still counts as on it).
 */
export function linesFromBreaks(
  onsets: Onset[],
  firsts: number[],
  from: number,
  bar: number,
  lines: number,
  lang: string,
  seed = 0,
): PatternLine[] {
  const sorted = [...onsets].sort((x, y) => x.t - y.t);
  const cuts = [...new Set([0, ...firsts.filter((k) => k > 0 && k < sorted.length)])].sort((a, b) => a - b);
  const groups = cuts.map((c, k) => sorted.slice(c, cuts[k + 1] ?? sorted.length));
  return Array.from({ length: lines }, (_, k) => {
    const g = groups[k] ?? [];
    if (!g.length) return sungLine([], from + k * bar, bar, lang, seed + k);
    const ref = from + bar * Math.max(0, Math.floor((g[0].t - from) / bar + 0.125));
    const next = groups[k + 1]?.[0]?.t;
    const last = g[g.length - 1].t - ref;
    // how long the last syllable can last: to the next line, or to the end of the bar it ends in
    const until = next !== undefined ? next - ref : Math.max(1, Math.ceil((last + 0.05) / bar)) * bar;
    return { ...sungLine(g, ref, bar, lang, seed + k, until), at: Math.round((ref - from) / bar) };
  });
}

/** a sung syllable (or a tap): where it starts, how loud, how long the voice holds it (sung only) */
export interface Onset {
  t: number;
  strength?: number | null;
  dur?: number | null;
}

/**
 * Where the singing breaks between groups of words ("Mentre ti guardo · questa notte · io mi sveglio con
 * te"): after syllable i (1-based) when the next one comes clearly later than the line's usual pace AND the
 * voice stopped in between (sung). Tapped: a clearly longer gap. Connected syllables stay one group.
 */
export function phraseBreaks(on: Onset[], beat: number): number[] {
  if (on.length < 3) return [];
  const ioi = on.slice(1).map((o, i) => o.t - on[i].t);
  const typical = [...ioi].sort((a, b) => a - b)[Math.floor(ioi.length / 2)];
  const out: number[] = [];
  ioi.forEach((d, i) => {
    const dur = on[i].dur;
    const silence = dur !== null && dur !== undefined ? d - dur : null;
    const later = d >= Math.max(1.45 * typical, typical + 0.1);
    // sung: the voice stopped — or, when the beat leaks into the mic and it never looks silent, a gap twice the pace
    const stopped = silence === null ? d >= Math.max(1.75 * typical, 0.5 * beat) : silence >= Math.max(0.1, 0.12 * beat) || d >= Math.max(2 * typical, typical + 0.15);
    if (later && stopped) out.push(i + 1);
  });
  return out;
}

/**
 * What was sung, without the strays: bumps after the singing ended (or before it began) — a few sounds standing
 * apart, more than a second from the rest — are the beat leaking in or a noise, not syllables.
 */
export function dropStrays<T extends Onset>(on: T[]): T[] {
  const sorted = [...on].sort((a, b) => a.t - b.t);
  const groups: T[][] = [];
  for (const o of sorted) {
    const g = groups[groups.length - 1];
    const last = g?.[g.length - 1];
    if (!g || o.t - (last!.t + (last!.dur ?? 0.15)) > 1) groups.push([o]);
    else g.push(o);
  }
  return groups.filter((g) => g.length >= 3).flat();
}

/**
 * Sung lines without "Next line": where each line starts (the index of its first syllable), for `lines`
 * lines. The cuts go where the singing rests longest — a line break is the longest silence around — with
 * the lines about equally long and at least 3 syllables each (never at the bar lines: a sung line often
 * starts before or after one).
 */
export function lineCuts(on: Onset[], lines: number): number[] {
  const n = on.length;
  if (lines < 2 || n < lines * 3) return [];
  const rest = on.slice(0, -1).map((o, i) => {
    const d = on[i + 1].t - o.t;
    return o.dur !== null && o.dur !== undefined ? Math.max(0, d - o.dur) : d;
  });
  const top = Math.max(...rest) || 1;
  const span = on[n - 1].t + (on[n - 1].dur ?? 0.2) - on[0].t;
  const target = span / lines;
  const len = (a: number, b: number) => on[b].t + (on[b].dur ?? 0.2) - on[a].t;
  // best[k][i]: lines 0..k-1 cover syllables 0..i-1
  const best = Array.from({ length: lines + 1 }, () => new Array<number>(n + 1).fill(-Infinity));
  const prev = Array.from({ length: lines + 1 }, () => new Array<number>(n + 1).fill(-1));
  best[0][0] = 0;
  for (let k = 1; k <= lines; k++)
    for (let i = 3 * k; i <= n; i++) {
      if (k === lines && i !== n) continue;
      for (let j = 3 * (k - 1); j <= i - 3; j++) {
        if (best[k - 1][j] === -Infinity) continue;
        // the silence before this line starts (none before the first), and how far its length is from the typical
        const gap = j > 0 ? rest[j - 1] / top : 0;
        const score = best[k - 1][j] + 2 * gap - Math.abs(len(j, i - 1) - target) / target;
        if (score > best[k][i]) {
          best[k][i] = score;
          prev[k][i] = j;
        }
      }
    }
  if (best[lines][n] === -Infinity) return [];
  const cuts: number[] = [];
  for (let k = lines, i = n; k > 1; k--) {
    i = prev[k][i];
    cuts.unshift(i);
  }
  return cuts;
}

/** example words group by group, a comma at each break: the words are as long as the singing's phrases */
export function exampleLine(n: number, stress: number[], breaks: number[], lang: string, seed: number): string {
  const cuts = [0, ...breaks.filter((b) => b > 0 && b < n), n];
  const used = new Set<string>();
  return cuts
    .slice(1)
    .map((end, g) => {
      const from = cuts[g];
      const words = exampleWords(end - from, stress.filter((s) => s > from && s <= end).map((s) => s - from), lang, seed * 7 + g, used);
      return g > 0 && lang !== "de" ? words.charAt(0).toLowerCase() + words.slice(1) : words;
    })
    .join(", ");
}

/** one sung / tapped line: its onsets timed from the bar line `start` */
function sungLine(on: Onset[], start: number, bar: number, lang: string, seed: number, until = bar): PatternLine {
  const beat = bar / 4;
  // sung before its bar line (a pickup): a little before 0, as sung — not pushed onto the bar line
  const offsets = on.map((o) => round(Math.max(-bar / 2, o.t - start)));
  const top = Math.max(0, ...on.map((o) => o.strength ?? 0));
  const loudness = (i: number) => on[i]?.strength ?? 0;
  const onBeat = offsets.map((o) => Math.abs(o / beat - Math.round(o / beat)) < 0.15);
  // stressed: on a beat, or sung clearly louder than the syllables around it (a few per line, as spoken)
  const marked = on.map((o, i) => {
    const s = o.strength ?? 0;
    const peak = top > 0 && s / top >= 0.8 && s > loudness(i - 1) && s >= loudness(i + 1);
    return onBeat[i] || peak;
  });
  // two stresses in a row only when both fall on beats
  for (let i = 1; i < marked.length; i++) if (marked[i] && marked[i - 1] && !onBeat[i]) marked[i] = false;
  const stress = marked.map((m, i) => (m ? i + 1 : 0)).filter(Boolean);
  const pauses = phraseBreaks(on, beat);
  // long: held a quarter or more (sung: as long as the voice holds it; tapped: until the next tap — a break isn't a long note)
  const long = offsets
    .map((t, i) => {
      const dur = on[i].dur;
      const held = dur !== null && dur !== undefined ? dur : pauses.includes(i + 1) ? 0 : (offsets[i + 1] ?? until) - t;
      return held >= beat * 0.95 ? i + 1 : 0;
    })
    .filter(Boolean);
  const n = on.length;
  return {
    text: n ? exampleLine(n, stress, pauses, lang, seed) : "",
    written: false,
    sung: true,
    syllables: n,
    stress,
    long,
    pauses,
    offsets,
  };
}

/**
 * Where each line of a stretch starts (its bar line, seconds from the stretch's start) when the pattern
 * repeats through it. Lines sung with their own spacing (`at`) keep it — line 2 a bar after line 1, line 3
 * two after… — and the pattern comes round again after `patternBars` bars; others take barsPerLine each.
 */
export function lineStarts(pattern: FlowPattern, bar: number, count: number): number[] {
  const ls = pattern.lines;
  const p = ls.length;
  if (!p) return [];
  if (ls.every((l) => l.at !== undefined)) {
    const span = patternBars(pattern, bar);
    return Array.from({ length: count }, (_, i) => (Math.floor(i / p) * span + ls[i % p].at!) * bar);
  }
  const per = barsPerLine(pattern) * bar;
  return Array.from({ length: count }, (_, i) => i * per);
}

/** how many lines of the pattern fit into a stretch `length` seconds long (sung: a line is sung before its end) */
export function linesIn(pattern: FlowPattern, bar: number, length: number): number {
  const ls = pattern.lines;
  if (ls.every((l) => l.at !== undefined) && ls.length) {
    let n = 0;
    for (const s of lineStarts(pattern, bar, 400)) {
      const l = ls[n % ls.length];
      const lastSyllable = (l.offsets[l.offsets.length - 1] ?? 0) * (bar / pattern.bar);
      if (s + lastSyllable > length) break;
      n++;
    }
    return Math.max(1, n);
  }
  return Math.max(1, Math.floor(length / (barsPerLine(pattern) * bar) + 0.3));
}

/**
 * Bars before a sung pattern comes round again: its lines as far apart as sung, to the beat (4 lines every
 * 1⅓ bars: 5¼ bars), never so few that its last line runs into the first one again.
 */
export function patternBars(pattern: FlowPattern, bar: number): number {
  const ls = pattern.lines;
  const scale = bar / pattern.bar;
  const start = (l: PatternLine) => (l.at ?? 0) * bar + (l.offsets[0] ?? 0) * scale;
  const p = ls.length;
  const avg = p > 1 ? (start(ls[p - 1]) - start(ls[0])) / (p - 1) : bar;
  const beat = bar / 4;
  let beats = Math.max(4, Math.round((p * avg) / beat));
  const last = ls[p - 1];
  const lastEnd = (last.at ?? 0) * bar + (last.offsets[last.offsets.length - 1] ?? 0) * scale + 0.1;
  // the first line again only after the last one is sung
  while (beats * beat + start(ls[0]) < lastEnd) beats++;
  return beats / 4;
}

/**
 * How many bars one pattern line takes (most lines: one). A line may start
 * late in its bar or run on into the next one — as tapped — as long as it
 * ends before the next line starts; only when lines would overlap does each
 * get more bars.
 */
export function barsPerLine(pattern: FlowPattern): number {
  const ls = pattern.lines.filter((l) => l.offsets.length);
  if (!ls.length) return 1;
  for (let k = 1; k < 4; k++) {
    const fits = ls.every((l, i) => {
      const next = ls[(i + 1) % ls.length];
      return l.offsets[l.offsets.length - 1] + 0.05 < k * pattern.bar + next.offsets[0];
    });
    if (fits) return k;
  }
  return 4;
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
    ...(pl.pauses?.length ? { pauses: pl.pauses } : {}),
    ...(pl.long?.length ? { long: pl.long } : {}),
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

/**
 * Sung lines from the words recognised in the take (1 call): the words are the text, their syllables (vowels
 * merged across words counted once) start where the words were sung, a break goes where you stopped between two
 * words. `firsts`: the index of each new line's first word ("Next line", or the longest pauses).
 */
export function linesFromWords(
  words: { text: string; start: number; end: number }[],
  firsts: number[],
  from: number,
  bar: number,
  lines: number,
  lang: string,
  /** where the voice was silent in the take (from its sound): a break shows there even when the recognised words run on */
  silences: { from: number; to: number }[] = [],
): PatternLine[] {
  const beat = bar / 4;
  const cuts = [...new Set([0, ...firsts.filter((k) => k > 0 && k < words.length)])].sort((a, b) => a - b);
  const groups = cuts.map((c, k) => words.slice(c, cuts[k + 1] ?? words.length));
  return Array.from({ length: lines }, (_, k) => {
    const g = groups[k] ?? [];
    if (!g.length) return sungLine([], from + k * bar, bar, lang, k);
    // a break after a word: the voice stopped before the next one, clearly longer than between the line's words
    // (recognised words often end where the next one starts, so also: the next word comes clearly later than the
    // line's pace per syllable would bring it, or the take was silent there)
    const gaps = g.slice(1).map((w, i) => w.start - g[i].end);
    const typical = [...gaps].sort((x, y) => x - y)[Math.floor(gaps.length / 2)] ?? 0;
    const syl = (w: { text: string }) => Math.max(1, prosody(w.text, lang).syllables);
    const perSyl = g.slice(0, -1).map((w, i) => (g[i + 1].start - w.start) / syl(w)).sort((x, y) => x - y);
    const pace = perSyl[Math.floor(perSyl.length / 2)] ?? 0.2;
    const breakAfter = gaps.map((d, i) => {
      const w = g[i];
      const next = g[i + 1];
      const late = next.start - w.start - syl(w) * pace;
      // (a real pause, not a consonant: those are silent for ~0.1 s too)
      const silent = silences.some((x) => x.to - x.from >= Math.max(0.18, 0.25 * beat) && x.from < next.start + 0.08 && x.to > Math.max(w.start, next.start - 0.6) && x.to > w.end - 0.15);
      return d >= Math.max(0.12, 0.15 * beat, 1.8 * typical) || late >= Math.max(0.15, 0.25 * beat) || silent;
    });
    // the text: the sung words, a comma at each break (a pause: no vowel merges across it)
    const ws = g.map((w, i) => (breakAfter[i] && !/[,;:.!?…]["»”’)]*$/.test(w.text) ? `${w.text},` : w.text));
    const text = ws.join(" ");
    const [a] = alignTakeLines([{ id: "l", text }], { words: g.map((w, i) => ({ ...w, text: ws[i] })) }, 0, lang, beat, true);
    if (!a || !a.times.length) return sungLine([], from + k * bar, bar, lang, k);
    const ref = from + bar * Math.max(0, Math.floor((g[0].start - from) / bar + 0.125));
    const at = Math.round((ref - from) / bar);
    const pauses = breakAfter
      .map((b, i) => (b ? prosody(ws.slice(0, i + 1).join(" "), lang, true).syllables : 0))
      .filter((n) => n > 0 && n < a.times.length);
    const n = a.times.length;
    const long = a.times
      .map((t, i) => {
        const next = i + 1 < n ? a.times[i + 1] : a.end;
        return next - t >= beat * 0.95 && !pauses.includes(i + 1) ? i + 1 : 0;
      })
      .filter(Boolean);
    return {
      text: text.charAt(0).toUpperCase() + text.slice(1),
      written: true,
      sung: true,
      commaPauses: true,
      at,
      syllables: n,
      stress: a.stress,
      long: a.held && !long.includes(n) ? [...long, n] : long,
      pauses: [...new Set(pauses)],
      // a pickup before the bar line keeps its time (a little below 0), not pushed onto the bar
      offsets: a.times.map((t) => round(Math.max(-bar / 2, t - ref))),
    };
  });
}
