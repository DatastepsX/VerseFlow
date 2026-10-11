import { prosody } from "@/lib/rhyme/prosody";
import type { AudioTrack, Line, Section } from "@/lib/types";
import type { TimedWord } from "./lyrics";
import { barLength, sectionRanges } from "./song-map";

/**
 * When each written line starts on the beat — what the player highlights and
 * where selecting a bar jumps to.
 *
 * 1. Known times win: a line's `audio_at` comes from the vocals (transcript
 *    words aligned to the lyrics) or from the writer tapping along.
 * 2. Between two known times, lines share the gap by their length in
 *    syllables (+1 for the breath between lines): a 5-syllable line gets
 *    about half the time of an 11-syllable one at the same delivery speed.
 * 3. After the last known time (or from the section start), a line of the
 *    section's typical length takes `bars_per_line` bars and shorter/longer
 *    lines scale with their syllables; if that overflows the section, the
 *    lines are compressed to fit it.
 */

type TimelineSection = Pick<Section, "id" | "audio_start" | "bars_per_line"> & {
  pattern?: string | null;
  lines: Pick<Line, "text" | "kind" | "audio_at">[];
};

export interface SectionTimeline {
  start: number;
  end: number;
  /** per index in section.lines; NaN for pattern (rhythm_ref) lines */
  starts: number[];
  /** when the last lyric line ends (estimated) */
  lyricsEnd: number;
}

const BREATH = 1;

function syllables(text: string, lang: string) {
  return text.trim() ? Math.max(2, prosody(text, lang).syllables) : 0;
}

/** typical syllables of a full line in this section: its pattern, else the median written line */
function typicalSyllables(s: TimelineSection, lang: string) {
  const pattern = (s.pattern ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const src = pattern.length ? pattern : s.lines.filter((l) => l.kind !== "lyric" && l.text.trim()).map((l) => l.text);
  const counts = (src.length ? src : s.lines.filter((l) => l.kind === "lyric").map((l) => l.text))
    .map((t) => syllables(t, lang))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  return counts.length ? Math.max(4, counts[Math.floor(counts.length / 2)]) : 11;
}

export function sectionTimeline(s: TimelineSection, start: number, end: number, bar: number | null, lang: string): SectionTimeline {
  const lyric = s.lines.map((l, k) => (l.kind === "lyric" ? k : -1)).filter((k) => k >= 0);
  const starts = s.lines.map(() => NaN);
  if (!lyric.length) return { start, end, starts, lyricsEnd: start };
  const ref = typicalSyllables(s, lang);
  // empty bars count as a full line
  const weight = lyric.map((k) => (syllables(s.lines[k].text, lang) || ref) + BREATH);
  const perWeight = bar ? (bar * (s.bars_per_line || 1)) / (ref + BREATH) : (end - start) / weight.reduce((a, b) => a + b, 0);

  // known times inside the section that keep the lines in order
  const anchors: { pos: number; at: number }[] = [];
  lyric.forEach((k, pos) => {
    const at = s.lines[k].audio_at;
    if (at === null || at === undefined || at < start - 0.5 || at >= end) return;
    const last = anchors[anchors.length - 1];
    if (last && at <= last.at + 0.2) return;
    anchors.push({ pos, at });
  });
  if (!anchors.length || anchors[0].pos > 0) anchors.unshift({ pos: 0, at: Math.min(start, anchors[0]?.at ?? start) });

  const at: number[] = new Array(lyric.length);
  for (let a = 0; a < anchors.length; a++) {
    const from = anchors[a];
    const to = anchors[a + 1];
    const stop = to ? to.pos : lyric.length;
    const w = weight.slice(from.pos, stop);
    const total = w.reduce((x, y) => x + y, 0);
    // between two known times: share the gap; after the last one: natural pace, squeezed to fit the section
    const span = to ? to.at - from.at : Math.min(total * perWeight, Math.max(0, end - from.at));
    let t = from.at;
    for (let i = from.pos; i < stop; i++) {
      at[i] = t;
      t += total ? (weight[i] / total) * span : 0;
    }
    if (!to) {
      lyric.forEach((k, pos) => (starts[k] = at[pos]));
      return { start, end, starts, lyricsEnd: Math.min(end, t) };
    }
  }
  lyric.forEach((k, pos) => (starts[k] = at[pos]));
  return { start, end, starts, lyricsEnd: end };
}

export type Timeline = Map<string, SectionTimeline>;

export function buildTimeline(sections: TimelineSection[], audio: AudioTrack | null, lang: string): Timeline {
  const map: Timeline = new Map();
  if (!audio) return map;
  const ranges = sectionRanges(sections, audio);
  const bar = barLength(audio);
  for (const s of sections) {
    const r = ranges.get(s.id);
    if (r) map.set(s.id, sectionTimeline(s, r.start, r.end, bar, lang));
  }
  return map;
}

/**
 * Section + line under the playhead. lineIndex = index in section.lines;
 * lines.length = past the written lines (the next bar to write);
 * null = before the first line (intro).
 */
export function positionIn(timeline: Timeline, time: number) {
  for (const [sectionId, t] of timeline) {
    if (time < t.start || time >= t.end) continue;
    let lineIndex: number | null = null;
    t.starts.forEach((s, k) => {
      if (!Number.isNaN(s) && s <= time + 0.05) lineIndex = k;
    });
    if (lineIndex !== null && time >= t.lyricsEnd && t.lyricsEnd < t.end - 0.5) lineIndex = t.starts.length;
    return { sectionId, lineIndex };
  }
  return null;
}

/** where a line starts on the beat (for jumping to it) */
export function lineStart(timeline: Timeline, sectionId: string, index: number) {
  const s = timeline.get(sectionId)?.starts[index];
  return s === undefined || Number.isNaN(s) ? null : s;
}

/* ---------- aligning the lyrics to the transcribed vocals ---------- */

const tokens = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/'/g, " ")
    .split(/\s+/)
    .filter(Boolean);

function close(a: string, b: string) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 3) return false;
  // one edit per 4 letters (transcription slips: "cannoli"/"canoli")
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return false;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n] <= Math.floor(Math.max(m, n) / 4);
}

/**
 * Start time of each line in the sung words, or null when the line can't be
 * found reliably (not sung, rewritten, ad-libs). Global alignment of the
 * lyrics' words to the transcript's words (extra transcript words are free:
 * ad-libs, backing vocals), then a line's start = its first matched word,
 * moved back by the words before it that weren't recognised.
 */
export function alignLines(lines: string[], words: TimedWord[]): (number | null)[] {
  const lt: { tok: string; line: number; pos: number }[] = [];
  lines.forEach((text, line) => tokens(text).forEach((tok, pos) => lt.push({ tok, line, pos })));
  const wt: { tok: string; start: number; end: number }[] = [];
  for (const w of words) for (const tok of tokens(w.text)) wt.push({ tok, start: w.start, end: w.end });
  const N = lt.length;
  const M = wt.length;
  const result: (number | null)[] = lines.map(() => null);
  if (!N || !M) return result;

  const MATCH = 3;
  const MISS = -1;
  const SKIP_LYRIC = -1;
  const SKIP_WORD = -0.3;
  // score[i][j]: best for the first i lyric words vs the first j transcript words
  const score = new Float32Array((N + 1) * (M + 1));
  const move = new Uint8Array((N + 1) * (M + 1)); // 1 diag, 2 skip lyric word, 3 skip transcript word
  const at = (i: number, j: number) => i * (M + 1) + j;
  for (let i = 1; i <= N; i++) {
    score[at(i, 0)] = i * SKIP_LYRIC;
    move[at(i, 0)] = 2;
  }
  for (let j = 1; j <= M; j++) move[at(0, j)] = 3; // leading transcript words are free
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      const diag = score[at(i - 1, j - 1)] + (close(lt[i - 1].tok, wt[j - 1].tok) ? MATCH : MISS);
      const up = score[at(i - 1, j)] + SKIP_LYRIC;
      const left = score[at(i, j - 1)] + SKIP_WORD;
      if (diag >= up && diag >= left) {
        score[at(i, j)] = diag;
        move[at(i, j)] = 1;
      } else if (up >= left) {
        score[at(i, j)] = up;
        move[at(i, j)] = 2;
      } else {
        score[at(i, j)] = left;
        move[at(i, j)] = 3;
      }
    }
  }
  // trailing transcript words are free too: end where the lyrics score best
  let j = M;
  for (let k = M - 1; k >= 0; k--) if (score[at(N, k)] > score[at(N, j)]) j = k;
  let i = N;
  const pair: number[] = new Array(N).fill(-1);
  while (i > 0) {
    const m = j > 0 ? move[at(i, j)] : 2;
    if (m === 1) {
      if (close(lt[i - 1].tok, wt[j - 1].tok)) pair[i - 1] = j - 1;
      i--;
      j--;
    } else if (m === 2) i--;
    else j--;
  }

  // per line: enough of it found → its start
  const byLine = new Map<number, { pos: number; w: number }[]>();
  lt.forEach((t, k) => {
    if (pair[k] < 0) return;
    const list = byLine.get(t.line) ?? [];
    list.push({ pos: t.pos, w: pair[k] });
    byLine.set(t.line, list);
  });
  lines.forEach((text, line) => {
    const total = tokens(text).length;
    const found = byLine.get(line) ?? [];
    if (!total || found.length < Math.max(2, Math.ceil(total * 0.5))) return;
    const first = found[0];
    if (first.pos > 2) return;
    const w = wt[first.w];
    const perWord = Math.max(0.12, Math.min(0.5, w.end - w.start));
    result[line] = Math.max(0, w.start - first.pos * perWord);
  });
  // keep only times that go forward
  let last = -Infinity;
  return result.map((t) => {
    if (t === null || t <= last + 0.2) return null;
    last = t;
    return t;
  });
}
