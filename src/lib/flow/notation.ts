import { syllableParts, type SyllablePart } from "@/lib/rhyme/syllabify";
import { wordsOf, type Mark, type MarkKind } from "@/lib/marks";
import type { Slots } from "@/lib/voice/guide";

/**
 * Symbols typed in a line while writing it — kept as the line's marks, out of its text (rhymes, syllables and
 * the AI never see them):
 *
 *   non_voglio_esagerare   double-time: the words joined by _ go twice as fast
 *   word /   or  word|      a short break after the word
 *   word //  or  word||     a long break
 *   word~                   the word held long
 *   word^                   a breath after the word
 *
 * Pure: the Lyrics editor turns them into marks and back, Hear and the flow display follow them.
 */

/** the marks the symbols stand for (the others are set in the marks editor) */
export const TYPED: MarkKind[] = ["double", "pause", "rest", "stretch", "breath"];

/** the toolbar while writing a line */
export const NOTATION_KEYS: { kind: MarkKind; insert: string; label: string }[] = [
  { kind: "double", insert: "_", label: "Double" },
  { kind: "pause", insert: " / ", label: "Break" },
  { kind: "rest", insert: " // ", label: "Long break" },
  { kind: "stretch", insert: "~", label: "Hold" },
  { kind: "breath", insert: "^ ", label: "Breath" },
];

// what follows a word: holds, breaths and breaks in any order ("vibra~ /", "vibra.//")
const TAIL = /([~^]|\/\/|\|\||\/|\|)+$/;

/** a line as typed (with symbols) → its text and the marks of the symbols */
export function parseNotation(input: string): { text: string; marks: Mark[] } {
  const words: string[] = [];
  const marks: Mark[] = [];
  const after = (kind: MarkKind) => {
    const at = words.length - 1;
    if (at >= 0 && !marks.some((m) => m.kind === kind && m.at === at)) marks.push({ kind, at });
  };
  const symbols = (t: string) => {
    for (const x of t.match(/\/\/|\|\||\/|\||~|\^/g) ?? []) {
      if (x === "~") after("stretch");
      else if (x === "^") after("breath");
      else after(x.length === 2 ? "rest" : "pause");
    }
  };
  for (const raw of input.trim().split(/\s+/).filter(Boolean)) {
    // "24/7" stays text: only symbols at a word's end count; _ joins words (double-time)
    const first = words.length;
    for (const p of raw.split("_")) {
      const tail = p.match(TAIL)?.[0] ?? "";
      const w = p.slice(0, p.length - tail.length);
      if (w) words.push(w);
      // a symbol on its own ("vibra /"): after the word before
      symbols(tail);
    }
    if (words.length - first > 1 && raw.includes("_")) marks.push({ kind: "double", at: first, to: words.length - 1 });
  }
  return { text: words.join(" "), marks: marks.filter((m) => m.at < words.length) };
}

/** the line with its typed marks as symbols (to edit it again) */
export function toNotation(text: string, marks: Mark[]): string {
  const words = wordsOf(text);
  const out: string[] = [];
  words.forEach((w, i) => {
    let s = w;
    if (marks.some((m) => m.kind === "stretch" && m.at === i)) s += "~";
    if (marks.some((m) => m.kind === "breath" && m.at === i)) s += "^";
    const joined = marks.some((m) => m.kind === "double" && i >= m.at && i < (m.to ?? m.at));
    if (marks.some((m) => m.kind === "rest" && m.at === i)) s += joined ? "//" : " //";
    else if (marks.some((m) => m.kind === "pause" && m.at === i)) s += joined ? "/" : " /";
    out.push(s + (i < words.length - 1 ? (joined ? "_" : " ") : ""));
  });
  return out.join("");
}

/** the marks set in the editor that symbols can't show (accent, up, down, echo) — kept while the words stay */
export const untyped = (marks: Mark[]) => marks.filter((m) => !TYPED.includes(m.kind));

/** each syllable's words: the first and the last word it covers (a merged syllable "te io" covers two) */
export function syllableWords(parts: SyllablePart[]) {
  let w = 0;
  return parts.map((p, i) => {
    if (i > 0 && p.space) w++;
    const start = w;
    w += (p.text.trim().match(/\s+/g) ?? []).length;
    return { start, end: w };
  });
}

/** the syllable where a word ends (its last one) */
export const lastSyllableOf = (spans: { start: number; end: number }[], word: number) => {
  for (let i = spans.length - 1; i >= 0; i--) if (spans[i].start <= word) return i;
  return -1;
};

/**
 * Hear with the marks: the line's syllables keep their order and their place in the line's stretch, but
 * double-time ones take half their time, a held one twice, and a break leaves a gap after its word — the
 * stretch stays the same, so the line still ends where it did. `long`: the held syllables (1-based, as a flow's).
 */
export function slotsWithMarks(slots: Slots, text: string, lang: string, marks: Mark[]): { slots: Slots; long: number[] } | null {
  const parts = syllableParts(text.trim(), lang);
  if (!parts?.length || !marks.length) return null;
  const n = parts.length;
  const m = slots.times.length;
  const t = (i: number) => (i >= n ? slots.end : m === n ? slots.times[i] : slots.times[Math.min(m - 1, Math.round((i * m) / n))]);
  const span = slots.end - t(0);
  if (span <= 0) return null;
  const words = syllableWords(parts);
  const durs = Array.from({ length: n }, (_, i) => Math.max(0.04, t(i + 1) - t(i)));
  const typical = [...durs].sort((a, b) => a - b)[Math.floor(n / 2)];
  const gaps = new Array<number>(n).fill(0);
  const long: number[] = [];
  for (const mk of marks) {
    if (mk.kind === "double")
      words.forEach((w, i) => {
        if (w.start >= mk.at && w.end <= (mk.to ?? mk.at)) durs[i] *= 0.5;
      });
    const end = lastSyllableOf(words, mk.at);
    if (end < 0) continue;
    if (mk.kind === "stretch") {
      durs[end] *= 2;
      long.push(end + 1);
    } else if (mk.kind === "pause") gaps[end] += typical * 1.5;
    else if (mk.kind === "rest") gaps[end] += typical * 3.5;
    else if (mk.kind === "breath") gaps[end] += typical;
  }
  const total = durs.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  const k = span / total;
  const times: number[] = [];
  let at = t(0);
  for (let i = 0; i < n; i++) {
    times.push(at);
    at += (durs[i] + gaps[i]) * k;
  }
  return { slots: { times, end: slots.end }, long };
}
