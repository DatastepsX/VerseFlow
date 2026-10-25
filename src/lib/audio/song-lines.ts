import { prosody } from "@/lib/rhyme/prosody";
import type { TimedWord } from "./lyrics";
import { snapSectionStart, type SnapGrid } from "./structure";

/**
 * The song rebuilt from its vocals: lines as they are sung, sections as they
 * are performed.
 *
 * Lines
 * - a new sentence always starts a new line (after . ! ? …)
 * - a pause in the vocals ends a line
 * - a line longer than ~2 bars (or 5 s) is split at its best point: a comma,
 *   else the longest gap between words
 * - a lone word that doesn't end a sentence joins the next line
 *
 * Sections
 * - rap: fast delivery (≥ ~6 syllables per second around the line)
 * - chorus/hook: lines that come back later in the song
 * - verse: the rest; an instrumental gap of ≥ 4 bars is a break
 * - ad-libs before the first verse ("Ohh yeah", "Ooh babe") are the intro
 * - a strong beat change between two lines splits a long verse / rap: the
 *   piece right before a chorus is the pre-chorus, otherwise the next verse
 * - a short tail after the last chorus is the outro
 * - section starts snap to the beat changes / bar lines, never after the
 *   first sung word (pickups stay in their section)
 */

export interface SungLine {
  text: string;
  start: number;
  end: number;
  syllables: number;
  /** 2 = the second line of a rhyming couplet */
  pair?: 0 | 1 | 2;
}

export type SectionKind = "intro" | "verse" | "pre" | "chorus" | "rap" | "break" | "outro";

export interface SongSection {
  kind: SectionKind;
  name: string;
  start: number;
  lines: SungLine[];
}

const SENTENCE_END = /[.!?…]["»”’)]*$/;

function join(words: TimedWord[]) {
  return words
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+([,.!?;:…’'])/g, "$1")
    .replace(/(['’])\s+/g, "$1")
    .replace(/^[,.;:!?…\-\s]+/, "")
    .trim();
}

function toLine(words: TimedWord[], lang: string): SungLine {
  const text = join(words);
  return { text, start: words[0].start, end: words[words.length - 1].end, syllables: prosody(text, lang).syllables };
}

/** split a too-long run of words at a comma, else at its longest gap */
function splitLong(words: TimedWord[], maxDur: number): TimedWord[][] {
  if (words.length < 4 || words[words.length - 1].end - words[0].start <= maxDur) return [words];
  let best = -1;
  let score = -Infinity;
  const mid = (words[0].start + words[words.length - 1].end) / 2;
  for (let i = 1; i < words.length - 1; i++) {
    const gap = words[i].start - words[i - 1].end;
    const comma = /[,;:]$/.test(words[i - 1].text) ? 0.5 : 0;
    // prefer the middle: both halves stay sing-able
    const balance = -Math.abs(words[i].start - mid) / (maxDur * 2);
    const s = gap + comma + balance;
    if (s > score) {
      score = s;
      best = i;
    }
  }
  if (best < 0) return [words];
  return [...splitLong(words.slice(0, best), maxDur), ...splitLong(words.slice(best), maxDur)];
}

export function sungLines(words: TimedWord[], lang: string, opts: { bar?: number | null } = {}): SungLine[] {
  const maxDur = opts.bar ? Math.max(3.2, Math.min(6, opts.bar * 2)) : 5;
  const runs: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    cur.push(w);
    const gap = next ? next.start - w.end : Infinity;
    const long = cur.length >= 4 ? 0.3 : 0.5;
    if (!next || SENTENCE_END.test(w.text) || gap > long) {
      runs.push(cur);
      cur = [];
    }
  }
  // lone fragments ("Un", "Solo") belong to the line after them when it follows closely
  const merged: TimedWord[][] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const next = runs[i + 1];
    const fragment = prosody(join(r), lang).syllables < 4 && !SENTENCE_END.test(r[r.length - 1].text);
    if (fragment && next && next[0].start - r[r.length - 1].end < 2.5) {
      runs[i + 1] = [...r, ...next];
      continue;
    }
    merged.push(r);
  }
  const runs2 = merged.flatMap((r) => splitLong(r, maxDur));
  // a line about twice as long as the lines around it is two lines sung in one breath: split at its comma
  const dur = (r: TimedWord[]) => r[r.length - 1].end - r[0].start;
  const out: TimedWord[][] = [];
  runs2.forEach((r, i) => {
    const around = runs2.slice(Math.max(0, i - 3), i + 4).filter((_, k) => k !== Math.min(3, i)).map(dur).sort((a, b) => a - b);
    const typical = around.length ? around[Math.floor(around.length / 2)] : Infinity;
    const commas = r.map((w, k) => (k > 0 && k < r.length - 1 && /[,;:]$/.test(w.text) ? k + 1 : -1)).filter((k) => k > 1 && k < r.length - 1);
    if (dur(r) > 1.6 * typical && commas.length) {
      const mid = (r[0].start + r[r.length - 1].end) / 2;
      const k = commas.sort((a, b) => Math.abs(r[a].start - mid) - Math.abs(r[b].start - mid))[0];
      out.push(r.slice(0, k), r.slice(k));
    } else out.push(r);
  });
  return out.map((r) => toLine(r, lang));
}

/* ---------- sections ---------- */

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

function similar(a: string, b: string) {
  const A = new Set(norm(a));
  const B = new Set(norm(b));
  if (A.size < 2 || B.size < 2) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}

const RAP_RATE = 6;

const ADLIB = /^(?:o+h*|a+h*|e+h*|u+h*|m+h*|ye+a*h*|ye+|ya+|yo|hey|babe|baby|na|la|da|uh|huh|wo+h*|woo+|skrt|brr+)$/;
/** only sounds, no words: "Ohhh, ohhh yeah.", "Ooo babe" */
export const isAdlib = (text: string) => {
  const w = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  return w.length > 0 && w.every((x) => ADLIB.test(x));
};

/** groups of lines that repeat each other (the chorus is one family, a repeated bridge another) */
export function lineFamilies(lines: SungLine[]) {
  const parent = lines.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++)
      if (Math.abs(lines[j].start - lines[i].start) > 10 && similar(lines[i].text, lines[j].text) >= 0.6) parent[find(j)] = find(i);
  return lines.map((_, i) => find(i));
}

/**
 * Repeated parts: families whose lines follow each other in at least two
 * places are one part (the chorus); a repeated block that never sits next to
 * it is another part (a bridge / post-chorus).
 */
export function repeatedParts(lines: SungLine[], chorus: boolean[]) {
  const fam = lineFamilies(lines);
  const pairs = new Map<string, number>();
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!chorus[i] || !chorus[i + 1] || fam[i] === fam[i + 1]) continue;
    const k = fam[i] < fam[i + 1] ? `${fam[i]}:${fam[i + 1]}` : `${fam[i + 1]}:${fam[i]}`;
    pairs.set(k, (pairs.get(k) ?? 0) + 1);
  }
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const [k, n] of pairs) {
    if (n < 2) continue;
    const [a, b] = k.split(":").map(Number);
    parent.set(find(b), find(a));
  }
  return fam.map((f) => find(f));
}

export function labelLines(lines: SungLine[]): ("verse" | "chorus" | "rap")[] {
  // delivery speed around each line (the line and its neighbours, pauses inside lines included)
  const rate = lines.map((_, i) => {
    const win = lines.slice(Math.max(0, i - 1), i + 2);
    const syl = win.reduce((n, l) => n + l.syllables, 0);
    const dur = win.reduce((n, l) => n + Math.max(0.4, l.end - l.start), 0);
    const own = lines[i].syllables / Math.max(0.4, lines[i].end - lines[i].start);
    // a full line is judged by its own speed (the first rap line after a slow chorus is still rap)
    return lines[i].syllables >= 8 ? Math.max(own * 0.95, syl / dur) : syl / dur;
  });
  // lines that come back ≥ 10 s later or earlier
  const repeated = lines.map((l, i) => lines.some((m, j) => j !== i && Math.abs(m.start - l.start) > 10 && similar(l.text, m.text) >= 0.6));
  const label = lines.map((_, i) => (repeated[i] ? "chorus" : rate[i] >= RAP_RATE ? "rap" : "verse") as "verse" | "chorus" | "rap");
  // a single repeated line inside a verse/rap is a quote, not a chorus
  for (let i = 0; i < label.length; i++) {
    if (label[i] !== "chorus") continue;
    const run = label[i - 1] === "chorus" || label[i + 1] === "chorus";
    if (!run) label[i] = rate[i] >= RAP_RATE ? "rap" : "verse";
  }
  // smooth single-line blips between two equal neighbours
  for (let i = 1; i < label.length - 1; i++) if (label[i - 1] === label[i + 1] && label[i] !== label[i - 1]) label[i] = label[i - 1];
  return label;
}

export function songSections(
  lines: SungLine[],
  grid: SnapGrid & { duration: number | null },
  projectType: string,
): SongSection[] {
  if (!lines.length) return [];
  const bar = grid.bpm ? (grid.beats_per_bar * 60) / grid.bpm : 2;
  const labels = labelLines(lines);
  const family = repeatedParts(
    lines,
    labels.map((l) => l === "chorus"),
  );
  // the repeated parts in the order they first appear: the first is the chorus, later ones bridges
  const chorusFamilies: number[] = [];
  const out: { kind: SectionKind; lines: SungLine[]; vocalStart: number; families: Set<number> }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prev = lines[i - 1];
    const last = out[out.length - 1];
    const gap = prev ? l.start - prev.end : 0;
    if (last && gap >= 4 * bar) out.push({ kind: "break", lines: [], vocalStart: prev.end + 0.2, families: new Set() });
    const cur = out[out.length - 1];
    // a different repeated part starts (its line and the next one belong to another family)
    const newFamily =
      labels[i] === "chorus" &&
      cur?.kind === "chorus" &&
      cur.lines.length >= 2 &&
      !cur.families.has(family[i]) &&
      (labels[i + 1] !== "chorus" || !cur.families.has(family[i + 1]));
    if (!cur || cur.kind !== labels[i] || newFamily)
      out.push({ kind: labels[i], lines: [l], vocalStart: l.start, families: new Set([family[i]]) });
    else {
      cur.lines.push(l);
      cur.families.add(family[i]);
    }
  }
  // tiny verse fragments (1 line) join the section before
  const merged: typeof out = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && s.kind === "verse" && s.lines.length < 2 && prev.kind !== "break") prev.lines.push(...s.lines);
    else merged.push(s);
  }
  // ad-libs before the first verse ("Ohhh yeah", "Ooo babe") are the intro
  if (merged[0] && merged[0].kind !== "break") {
    const s = merged[0];
    const k = s.lines.findIndex((l) => !isAdlib(l.text));
    if (k > 0 && s.lines.length - k >= 2)
      merged.splice(0, 1, { kind: "intro", lines: s.lines.slice(0, k), vocalStart: s.vocalStart, families: new Set() }, { ...s, lines: s.lines.slice(k), vocalStart: s.lines[k].start });
  }
  // where the beat changes between two lines, a long verse / rap splits: the piece right before a chorus is
  // the pre-chorus, otherwise the next verse
  const strong = (grid.changes ?? []).filter((c) => c.s >= 0.5);
  type Part = (typeof merged)[number];
  const split = (s: Part): Part[] => {
    const n = s.lines.length;
    if ((s.kind !== "verse" && s.kind !== "rap") || n < 4) return [s];
    let best: { k: number; s: number } | null = null;
    for (const c of strong) {
      let k = s.lines.findIndex((l) => l.start >= c.t - 0.25);
      // a couplet stays together: its first line sung right before the change (a pickup) moves along
      if (k > 0 && s.lines[k].pair === 2 && c.t - s.lines[k - 1].start <= 0.6 * bar) k--;
      if (k < 2 || k > n - 2 || s.lines[k].pair === 2) continue;
      // between the lines, not in the middle of one
      if (s.lines[k - 1].end > c.t + 0.5 * bar) continue;
      if (c.t - s.lines[0].start < 4 * bar - 0.01 || s.lines[n - 1].end - c.t < 3.5 * bar) continue;
      if (!best || c.s > best.s) best = { k, s: c.s };
    }
    if (!best) return [s];
    return [...split({ ...s, lines: s.lines.slice(0, best.k) }), ...split({ ...s, lines: s.lines.slice(best.k), vocalStart: s.lines[best.k].start })];
  };
  const pieces = merged.flatMap((s, i) => {
    const out = split(s);
    const last = out[out.length - 1];
    if (out.length > 1 && merged[i + 1]?.kind === "chorus" && last.lines.length <= 8 && last.lines[last.lines.length - 1].end - last.vocalStart <= 8.5 * bar)
      last.kind = "pre";
    return out;
  });
  merged.splice(0, merged.length, ...pieces);
  // a last lone ad-lib after a break, or a short tail after the last chorus, is the outro
  const tail = merged[merged.length - 1];
  const beforeTail = merged[merged.length - 2]?.kind;
  if (tail && beforeTail && ((tail.lines.length < 2 && beforeTail === "break") || (beforeTail === "chorus" && tail.kind !== "chorus" && tail.lines.length <= 3)))
    tail.kind = "outro";

  const first = lines[0].start;
  const sections: SongSection[] = [];
  if (first >= 2 * bar && merged[0]?.kind !== "intro") sections.push({ kind: "intro", name: "Intro", start: 0, lines: [] });
  const counts: Record<string, number> = {};
  const rapSong = projectType === "rap";
  for (const [i, s] of merged.entries()) {
    // never start after the first sung word: a pickup stays in its section — a bar earlier, or just before
    // the pickup when the part before still sings there
    let start = snapSectionStart(s.vocalStart, grid);
    if (start > s.vocalStart + 0.15 && grid.bpm) {
      const prev = merged[i - 1]?.lines.at(-1)?.end ?? 0;
      start = start - bar < prev ? Math.max(prev, s.vocalStart - 0.1) : Math.max(0, start - bar);
    }
    if (!sections.length) start = s.kind === "intro" ? 0 : Math.min(start, s.vocalStart);
    const kind = s.kind;
    // the part most of the section's lines belong to: the first repeated part is the chorus, others bridges
    let fam = -1;
    if (s.kind === "chorus") {
      const count = new Map<number, number>();
      for (const l of s.lines) {
        const f = family[lines.indexOf(l)];
        count.set(f, (count.get(f) ?? 0) + 1);
      }
      fam = [...count.entries()].sort((x, y) => y[1] - x[1])[0][0];
      if (!chorusFamilies.includes(fam)) chorusFamilies.push(fam);
    }
    const isBridge = fam >= 0 && chorusFamilies.indexOf(fam) > 0;
    const base =
      kind === "chorus"
        ? isBridge
          ? "Bridge"
          : rapSong
            ? "Hook"
            : "Chorus"
        : kind === "rap"
          ? "Rap"
          : kind === "pre"
            ? rapSong
              ? "Pre-hook"
              : "Pre-chorus"
            : kind === "intro"
              ? "Intro"
              : kind === "break"
            ? "Break"
            : kind === "outro"
              ? "Outro"
              : rapSong
                ? "Rap"
                : "Verse";
    counts[base] = (counts[base] ?? 0) + 1;
    const numbered = base === "Verse" || base === "Rap";
    sections.push({ kind, name: numbered ? `${base} ${counts[base]}` : base, start: Math.round(start * 1000) / 1000, lines: s.lines });
  }
  // keep starts in order
  for (let i = 1; i < sections.length; i++) if (sections[i].start <= sections[i - 1].start) sections[i].start = sections[i - 1].start + 0.01;
  const lastLine = lines[lines.length - 1];
  if (grid.duration && grid.duration - lastLine.end >= 4 * bar)
    sections.push({ kind: "outro", name: "Outro", start: Math.round(snapSectionStart(lastLine.end + bar / 2, grid) * 1000) / 1000, lines: [] });
  return sections;
}
