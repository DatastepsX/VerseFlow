import { prosody } from "@/lib/rhyme/prosody";
import { syllableParts } from "@/lib/rhyme/syllabify";

/**
 * A take of lyrics that are already written, aligned word by word (forced
 * alignment: the recording + the text → when each character is sung). Every
 * line gets the time of each of its sung syllables — the flow as rapped in
 * the take — and where its singing ends. Times are song time: the take's
 * sample 0 is at `offset` on the beat.
 */

export interface Alignment {
  characters?: { text: string; start: number; end: number }[];
  words?: { text: string; start: number; end: number; loss?: number }[];
  loss?: number;
}

export interface AlignedLine {
  id: string;
  /** song time where each sung syllable starts (as many as the line's sung syllables) */
  times: number[];
  end: number;
  syllables: number;
  /** 1-based */
  stress: number[];
  held: boolean;
  /** the alignment's own doubt about the line's words (lower = surer) */
  loss: number | null;
}

const wordsOf = (text: string) => text.trim().split(/\s+/).filter(Boolean);
const isSpace = (c: string) => /\s/.test(c);
const r3 = (t: number) => Math.round(t * 1000) / 1000;

/** the text sent for alignment: one line per line, single spaces */
export function alignmentText(lines: { text: string }[]) {
  return lines.map((l) => wordsOf(l.text).join(" ")).join("\n");
}

export function alignTakeLines(lines: { id: string; text: string }[], res: Alignment, offset: number, lang: string, beat: number): AlignedLine[] {
  const sent = alignmentText(lines);
  // character times, matched on the non-space characters (the response may or may not list spaces / line breaks)
  const chars = (res.characters ?? []).filter((c) => c.text && !isSpace(c.text));
  const ownChars = [...sent].filter((c) => !isSpace(c));
  const byChar = chars.length === ownChars.length ? chars : null;
  // word times, in order
  const words = (res.words ?? []).filter((w) => w.text && !isSpace(w.text));
  const ownWords = lines.flatMap((l) => wordsOf(l.text));
  const byWord = words.length === ownWords.length ? words : null;
  if (!byChar && !byWord) return [];

  const out: AlignedLine[] = [];
  let ci = 0; // non-space characters before this line
  let wi = 0; // words before this line
  for (const l of lines) {
    const text = wordsOf(l.text).join(" ");
    const ws = wordsOf(text);
    // where each word starts in the line (its index among non-space characters, and its length)
    const wordAt: { from: number; len: number }[] = [];
    let k = 0;
    for (const w of ws) {
      wordAt.push({ from: k, len: w.length });
      k += w.length;
    }
    /** the time where the line's non-space character `i` is sung */
    const timeOf = (i: number) => {
      if (byChar) return byChar[ci + i].start;
      const w = Math.max(0, wordAt.findIndex((x) => i < x.from + x.len));
      const t = byWord![wi + w];
      return t.start + ((i - wordAt[w].from) / Math.max(1, wordAt[w].len)) * Math.max(0, t.end - t.start);
    };
    const lastWord = byWord?.[wi + ws.length - 1];
    const end = byChar ? byChar[ci + k - 1].end : lastWord!.end;
    // each sung syllable starts at its first letter (a syllable merged across words: at the first one's)
    const parts = syllableParts(text, lang);
    const starts: number[] = [];
    if (parts) {
      let pos = 0;
      for (const p of parts) {
        const first = [...p.text].findIndex((c) => /[\p{L}\p{N}]/u.test(c));
        starts.push(pos + Math.max(0, first - (p.text.slice(0, Math.max(0, first)).match(/\s/g)?.length ?? 0)));
        pos += [...p.text].filter((c) => !isSpace(c)).length;
      }
    } else for (const w of wordAt) starts.push(w.from);
    const times = starts.map((i) => r3(offset + timeOf(Math.min(i, k - 1))));
    const p = prosody(text, lang);
    const lineLoss = byWord ? byWord.slice(wi, wi + ws.length).map((w) => w.loss ?? 0) : [];
    out.push({
      id: l.id,
      times,
      end: r3(offset + end),
      syllables: times.length,
      stress: (p.syllables === times.length ? p.stresses : []).map((s) => s + 1),
      held: end - (times.length ? times[times.length - 1] - offset : end) > 0.75 * beat,
      loss: lineLoss.length ? Math.round((lineLoss.reduce((a, b) => a + b, 0) / lineLoss.length) * 1000) / 1000 : null,
    });
    ci += k;
    wi += ws.length;
  }
  return out;
}
