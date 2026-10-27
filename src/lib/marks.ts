/**
 * Performance marks on a line's words — notes for recording, kept apart from
 * the text (rhymes, syllables and the AI never see them): a pause or a
 * breath after a word, words rapped in double-time, a stretched or stressed
 * word, the voice going up or down, an echo / ad-lib.
 *
 * A mark points at word indices of the text it was made on; when the line's
 * text changes, its marks no longer fit and stop showing.
 */

export type MarkKind = "pause" | "rest" | "breath" | "double" | "stretch" | "accent" | "up" | "down" | "echo";

export interface Mark {
  kind: MarkKind;
  /** word index (0-based); "double": the first word */
  at: number;
  /** "double": the last word */
  to?: number;
}

export interface LineMarks {
  /** the text the marks were made on */
  text: string;
  items: Mark[];
}

export const MARK_KINDS: { kind: MarkKind; symbol: string; label: string; about: string; range?: boolean; after?: boolean }[] = [
  { kind: "pause", symbol: "‖", label: "Pause", about: "a short stop after this word", after: true },
  { kind: "rest", symbol: "‖‖", label: "Long break", about: "a long stop after this word", after: true },
  { kind: "breath", symbol: "ˇ", label: "Breath", about: "breathe after this word", after: true },
  { kind: "double", symbol: "2×", label: "Double-time", about: "these words twice as fast — tap the first, then the last", range: true },
  { kind: "stretch", symbol: "~", label: "Stretch", about: "hold this word long" },
  { kind: "accent", symbol: "›", label: "Accent", about: "hit this word hard" },
  { kind: "up", symbol: "↗", label: "Up", about: "the voice goes up" },
  { kind: "down", symbol: "↘", label: "Down", about: "the voice goes down" },
  { kind: "echo", symbol: "⟲", label: "Echo / ad-lib", about: "a second voice repeats it" },
];

export const markInfo = (k: MarkKind) => MARK_KINDS.find((m) => m.kind === k)!;

export const wordsOf = (text: string) => text.trim().split(/\s+/).filter(Boolean);

/** the marks that fit the line as it is now */
export function marksFor(line: { text: string; marks?: LineMarks | null }): Mark[] {
  return line.marks && line.marks.text === line.text.trim() ? line.marks.items : [];
}

/** marks sent by the browser: known kinds, indices inside the text */
export function cleanMarks(v: unknown, text: string): LineMarks | null | undefined {
  if (v === null) return null;
  if (!v || typeof v !== "object") return undefined;
  const n = wordsOf(text).length;
  const items = (Array.isArray((v as LineMarks).items) ? (v as LineMarks).items : [])
    .filter((m) => m && MARK_KINDS.some((k) => k.kind === m.kind) && Number.isInteger(m.at) && m.at >= 0 && m.at < n)
    .map((m) => ({ kind: m.kind, at: m.at, ...(m.kind === "double" && Number.isInteger(m.to) ? { to: Math.min(n - 1, Math.max(m.at, m.to!)) } : {}) }))
    .slice(0, 60);
  return items.length ? { text: text.trim(), items } : null;
}
