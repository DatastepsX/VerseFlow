/**
 * Turns a timed transcript of the vocals into VerseFlow lines and sections.
 *
 * - Lines: with a bar grid, every written line covers `bars_per_line` bars, so
 *   line i of a section is exactly the bar(s) the beat plays at that point
 *   (the same mapping the player uses to highlight the current line). Without
 *   a grid, lines are split at pauses in the vocals.
 * - Sections (optional): instrumental stretches of ≥ 2 bars split the song
 *   into blocks; runs of ≥ 2 lines that come back later are the chorus/hook;
 *   the rest are verses. Leading/trailing instrumentals become Intro/Outro.
 * - Filling never overwrites: a line that already has text is kept, only
 *   empty or missing lines receive the transcribed text.
 */

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface Grid {
  bpm: number | null;
  beat_offset: number;
  beats_per_bar: number;
  duration: number | null;
}

export interface PlanSectionInput {
  id: string;
  name: string;
  audio_start: number | null;
  bars_per_line: number;
  lines: { text: string }[];
}

export type LineAction = "fill" | "keep" | "add";

export interface PlannedSection {
  /** existing section id, or null for a section the plan creates */
  id: string | null;
  name: string;
  start: number;
  end: number;
  lines: { index: number; text: string; action: LineAction }[];
}

export interface LyricsPlan {
  sections: PlannedSection[];
  /** existing sections that are empty and unanchored, replaced by detected ones */
  removeSectionIds: string[];
  filled: number;
  kept: number;
  /** words that fall outside every section */
  unplaced: number;
}

/** words start a little before the beat they belong to (pickups) */
const LEAD = 0.12;

export function cleanWords(raw: { text: string; start?: number | null; end?: number | null; type?: string }[]): TimedWord[] {
  return raw
    .filter((w) => (w.type ?? "word") === "word" && w.start != null && w.end != null && w.text.trim())
    .map((w) => ({ text: w.text.trim(), start: w.start as number, end: w.end as number }));
}

function joinWords(words: TimedWord[]) {
  return words
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+([,.!?;:…’'])/g, "$1")
    .replace(/(['’])\s+/g, "$1")
    .replace(/^[,.;:!?…\-\s]+/, "")
    .trim();
}

function barLen(grid: Grid) {
  return grid.bpm ? (grid.beats_per_bar * 60) / grid.bpm : null;
}

/** Index of the bar a time belongs to (bar 0 starts at beat_offset). */
function barIndex(t: number, grid: Grid, bl: number) {
  return Math.floor((t + LEAD - grid.beat_offset) / bl);
}

/** One line per bar of the whole song: text of the words starting in that bar. */
export function barLines(words: TimedWord[], grid: Grid): string[] {
  const bl = barLen(grid);
  if (!bl) return [];
  const byBar = new Map<number, TimedWord[]>();
  for (const w of words) {
    const b = Math.max(0, barIndex(w.start, grid, bl));
    (byBar.get(b) ?? byBar.set(b, []).get(b)!).push(w);
  }
  const last = Math.max(-1, ...byBar.keys());
  return Array.from({ length: last + 1 }, (_, b) => joinWords(byBar.get(b) ?? []));
}

/** Without a grid: split the vocals at pauses into phrases. */
export function phraseLines(words: TimedWord[], pause = 0.35, maxWords = 14) {
  const out: { start: number; end: number; text: string }[] = [];
  let cur: TimedWord[] = [];
  const flush = () => {
    if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: joinWords(cur) });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > pause || cur.length >= maxWords)) flush();
    cur.push(w);
  }
  flush();
  return out;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);

export function similarity(a: string, b: string) {
  const A = new Set(norm(a));
  const B = new Set(norm(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Mark bars that belong to a repeated run of ≥ 2 similar lines (chorus / hook). */
export function repeatedBars(lines: string[], minRun = 2, threshold = 0.6): boolean[] {
  const mark = lines.map(() => false);
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    if (!lines[i]) continue;
    for (let j = i + minRun; j < n; j++) {
      let k = 0;
      while (i + k < j && j + k < n && lines[i + k] && lines[j + k] && similarity(lines[i + k], lines[j + k]) >= threshold) k++;
      if (k >= minRun) for (let d = 0; d < k; d++) mark[i + d] = mark[j + d] = true;
    }
  }
  return mark;
}

interface Block {
  startBar: number;
  endBar: number; // exclusive
  kind: "intro" | "outro" | "verse" | "chorus" | "break";
}

/** Split the song's bars into sections. */
export function detectBlocks(lines: string[], totalBars: number, gapBars = 2): Block[] {
  const vocal = lines.map((l) => !!l);
  const first = vocal.indexOf(true);
  if (first < 0) return [{ startBar: 0, endBar: totalBars, kind: "intro" }];
  const last = vocal.lastIndexOf(true);
  const rep = repeatedBars(lines);
  const blocks: Block[] = [];
  if (first >= 2) blocks.push({ startBar: 0, endBar: first, kind: "intro" });

  let start = first > 0 && first < 2 ? 0 : first;
  let label: "verse" | "chorus" = rep[first] ? "chorus" : "verse";
  let silent = 0;
  for (let b = first; b <= last + 1; b++) {
    if (b > last) {
      blocks.push({ startBar: start, endBar: b, kind: label });
      break;
    }
    if (!vocal[b]) {
      silent++;
      continue;
    }
    const lbl = rep[b] ? "chorus" : "verse";
    if (silent >= gapBars) {
      // an instrumental gap closes the block: a short gap stays at the end of it
      // (no empty lines at the start of the next section), a long one is a break
      const gapStart = b - silent;
      if (silent >= 4) {
        blocks.push({ startBar: start, endBar: gapStart, kind: label });
        blocks.push({ startBar: gapStart, endBar: b, kind: "break" });
      } else blocks.push({ startBar: start, endBar: b, kind: label });
      start = b;
      label = lbl;
    } else if (lbl !== label && b - start >= 2) {
      blocks.push({ startBar: start, endBar: b, kind: label });
      start = b;
      label = lbl;
    }
    silent = 0;
  }
  if (totalBars - (last + 1) >= 2) blocks.push({ startBar: last + 1, endBar: totalBars, kind: "outro" });
  else if (blocks.length) blocks[blocks.length - 1].endBar = Math.max(blocks[blocks.length - 1].endBar, totalBars);
  // merge tiny non-chorus fragments (< 2 bars) into the previous block
  return blocks.filter((b, i, all) => {
    if (b.endBar - b.startBar >= 2 || i === 0 || b.kind === "intro" || b.kind === "outro") return true;
    all[i - 1].endBar = b.endBar;
    return false;
  });
}

function blockNames(blocks: Block[], projectType: string) {
  let verse = 0;
  const hook = projectType === "rap" ? "Hook" : "Chorus";
  const verseName = projectType === "rap" ? "Rap" : "Verse";
  return blocks.map((b) =>
    b.kind === "intro" ? "Intro" : b.kind === "outro" ? "Outro" : b.kind === "break" ? "Break" : b.kind === "chorus" ? hook : `${verseName} ${++verse}`,
  );
}

/** Fill lines of a section from per-line texts without overwriting what is written. */
function fillSection(existing: { text: string }[], texts: string[]) {
  // trim trailing empty slots; keep inner/leading empties so line i stays bar i
  let n = texts.length;
  while (n > 0 && !texts[n - 1]) n--;
  const out: PlannedSection["lines"] = [];
  for (let i = 0; i < Math.max(n, 0); i++) {
    const has = existing[i]?.text.trim();
    if (has) out.push({ index: i, text: existing[i].text, action: "keep" });
    else if (i < existing.length) {
      if (texts[i]) out.push({ index: i, text: texts[i], action: "fill" });
    } else out.push({ index: i, text: texts[i], action: "add" });
  }
  return out;
}

export function planLyrics(opts: {
  words: TimedWord[];
  grid: Grid;
  sections: PlanSectionInput[];
  projectType: string;
  /** create sections from the song when none are anchored */
  autoSections: boolean;
}): LyricsPlan {
  const { words, grid, sections } = opts;
  const bl = barLen(grid);
  const duration = grid.duration ?? (words.length ? words[words.length - 1].end + 1 : 0);
  const anchored = sections.filter((s) => s.audio_start != null).sort((a, b) => a.audio_start! - b.audio_start!);

  // target sections with time ranges
  let targets: { id: string | null; name: string; start: number; end: number; bars_per_line: number; lines: { text: string }[] }[] = [];
  let removeSectionIds: string[] = [];

  if (anchored.length) {
    targets = anchored.map((s, i) => ({
      id: s.id,
      name: s.name,
      start: s.audio_start!,
      end: i + 1 < anchored.length ? anchored[i + 1].audio_start! : duration,
      bars_per_line: s.bars_per_line || 1,
      lines: s.lines,
    }));
  } else if (opts.autoSections) {
    if (bl) {
      const lines = barLines(words, grid);
      const totalBars = Math.max(lines.length, Math.ceil((duration - grid.beat_offset) / bl));
      const blocks = detectBlocks(lines, totalBars);
      const names = blockNames(blocks, opts.projectType);
      targets = blocks.map((b, i) => ({
        id: null,
        name: names[i],
        start: Math.max(0, grid.beat_offset + b.startBar * bl),
        end: grid.beat_offset + b.endBar * bl,
        bars_per_line: 1,
        lines: [],
      }));
      if (targets.length) targets[0].start = Math.min(targets[0].start, grid.beat_offset);
    } else {
      // no grid: one section per vocal block separated by ≥ 3 s of silence
      const phrases = phraseLines(words);
      let cur: typeof phrases = [];
      const groups: (typeof phrases)[] = [];
      for (const p of phrases) {
        if (cur.length && p.start - cur[cur.length - 1].end >= 3) groups.push((cur = []));
        if (!groups.length) groups.push(cur);
        cur.push(p);
      }
      const verseName = opts.projectType === "rap" ? "Rap" : "Verse";
      targets = groups.map((g, i) => ({
        id: null,
        name: `${verseName} ${i + 1}`,
        start: i === 0 ? 0 : g[0].start - 0.2,
        end: i + 1 < groups.length ? groups[i + 1][0].start - 0.2 : duration,
        bars_per_line: 1,
        lines: [],
      }));
    }
    removeSectionIds = sections.filter((s) => s.audio_start == null && !s.lines.some((l) => l.text.trim())).map((s) => s.id);
  }

  const out: PlannedSection[] = [];
  let placed = 0;
  let filled = 0;
  let kept = 0;
  for (const t of targets) {
    const inside = words.filter((w) => w.start + LEAD >= t.start && w.start + LEAD < t.end);
    placed += inside.length;
    let texts: string[];
    if (bl) {
      const unit = bl * t.bars_per_line;
      const count = Math.max(0, Math.round((t.end - t.start) / unit));
      texts = Array.from({ length: count }, () => "");
      const groups = new Map<number, TimedWord[]>();
      for (const w of inside) {
        const i = Math.min(count - 1, Math.max(0, Math.floor((w.start + LEAD - t.start) / unit)));
        (groups.get(i) ?? groups.set(i, []).get(i)!).push(w);
      }
      for (const [i, ws] of groups) texts[i] = joinWords(ws);
    } else {
      texts = phraseLines(inside).map((p) => p.text);
    }
    const lines = fillSection(t.lines, texts);
    filled += lines.filter((l) => l.action !== "keep" && l.text).length;
    kept += lines.filter((l) => l.action === "keep").length;
    out.push({ id: t.id, name: t.name, start: Math.round(t.start * 1000) / 1000, end: t.end, lines });
  }
  return { sections: out, removeSectionIds, filled, kept, unplaced: words.length - placed };
}
