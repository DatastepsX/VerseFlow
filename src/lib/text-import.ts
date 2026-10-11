/**
 * Pasted lyrics / poem → sections and lines.
 *
 * - headings become sections: "[Chorus]", "Chorus:", "## Hook", "RITORNELLO",
 *   "Strofa 2", "Verse 1 (x2)"…
 * - without headings, blank lines separate stanzas; a stanza that comes back
 *   later is the chorus (named once, repeats keep the name)
 * - one line of text = one line; very long prose lines are split at
 *   sentence ends so each line stays a line
 */

export interface ImportedSection {
  name: string;
  lines: string[];
  /** lines per stanza when stanzas were combined into one part (couplets → 2) */
  groupSize?: number;
}

const HEADING_WORDS =
  /^(intro|outro|verse|chorus|pre[- ]?chorus|post[- ]?chorus|hook|bridge|break|interlude|refrain|rap|strofa|ritornello|ponte|inciso|special|strophe|refrain|couplet|refrão|estribillo|coro|verso|stanza|part|parte|teil)\b/i;

function headingName(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  const bracket = t.match(/^\[(.+?)\]$|^\((.+?)\)$|^#+\s*(.+)$/);
  if (bracket) return clean(bracket[1] ?? bracket[2] ?? bracket[3]);
  const colon = t.match(/^(.{2,30}):$/);
  if (colon && HEADING_WORDS.test(colon[1])) return clean(colon[1]);
  // a short line that is only a section word (+ number / repeat mark)
  // (only the word, with an optional number / roman numeral / repeat mark — "Ritornello uno sole" is a lyric line)
  const bare = t.match(HEADING_WORDS);
  if (bare && /^\s*(\d+|[ivx]+)?\s*(\(?x\d+\)?)?\s*$/i.test(t.slice(bare[0].length))) return clean(t);
  return null;
}

function clean(name: string) {
  const n = name
    .replace(/\(?x\d+\)?/i, "")
    .replace(/[:\-–—]+$/, "")
    .trim();
  // RITORNELLO → Ritornello
  return n === n.toUpperCase() ? n.charAt(0) + n.slice(1).toLowerCase() : n;
}

/** prose pasted as one long line: split at sentence ends */
function splitProse(line: string): string[] {
  if (line.length <= 90) return [line];
  const parts = line.match(/[^.!?…]+[.!?…]+["»”’)]*\s*|[^.!?…]+$/g) ?? [line];
  return parts.map((p) => p.trim()).filter(Boolean);
}

const norm = (s: string[]) =>
  s
    .join(" ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function parseText(text: string, kind: "song" | "rap" | "poem" | string = "song"): ImportedSection[] {
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: { heading: string | null; lines: string[] }[] = [];
  let cur: { heading: string | null; lines: string[] } | null = null;
  for (const raw of rows) {
    const line = raw.replace(/\s+/g, " ").trim();
    const h = headingName(line);
    if (h) {
      cur = { heading: h, lines: [] };
      blocks.push(cur);
      continue;
    }
    if (!line) {
      // a blank line ends a stanza (a headed block keeps collecting until its stanza ends)
      if (cur && cur.lines.length) cur = null;
      continue;
    }
    if (!cur) {
      cur = { heading: null, lines: [] };
      blocks.push(cur);
    }
    cur.lines.push(...splitProse(line));
  }
  const filled = blocks.filter((b) => b.lines.length || b.heading);
  if (!filled.some((b) => b.lines.length)) return [];

  const anyHeading = filled.some((b) => b.heading);
  const out: ImportedSection[] = [];
  if (anyHeading) {
    // stanzas without a heading continue the section before them
    for (const b of filled) {
      if (b.heading || !out.length) out.push({ name: b.heading ?? (kind === "poem" ? "Stanza 1" : "Verse 1"), lines: [...b.lines] });
      else out[out.length - 1].lines.push(...b.lines);
    }
    return out.filter((s) => s.lines.length);
  }

  // no headings: stanzas; a stanza that comes back is the chorus
  const keys = filled.map((b) => norm(b.lines));
  const repeated = keys.map((k, i) => keys.some((o, j) => j !== i && o === k && k.length > 0));
  const chorus = kind === "rap" ? "Hook" : "Chorus";
  const verse = kind === "poem" ? "Stanza" : kind === "rap" ? "Rap" : "Verse";
  // many short stanzas (couplets, single lines): combine them into parts of ~8–12 lines
  const short = filled.length > 8 && filled.reduce((n, b) => n + b.lines.length, 0) / filled.length < 4;
  if (short) {
    const sizes = filled.map((b) => b.lines.length);
    const common = [1, 2, 3, 4].sort((a, b) => sizes.filter((x) => x === b).length - sizes.filter((x) => x === a).length)[0];
    let n = 0;
    let cur: ImportedSection | null = null;
    for (const [i, b] of filled.entries()) {
      if (repeated[i] && kind !== "poem") {
        out.push({ name: chorus, lines: [...b.lines] });
        cur = null;
        continue;
      }
      if (!cur || cur.lines.length >= 8) {
        cur = { name: `${kind === "poem" || kind === "speech" || kind === "story" ? "Part" : verse} ${++n}`, lines: [], groupSize: common };
        out.push(cur);
      }
      cur.lines.push(...b.lines);
    }
    return out;
  }
  let n = 0;
  for (const [i, b] of filled.entries()) {
    out.push({ name: repeated[i] && kind !== "poem" ? chorus : `${verse} ${++n}`, lines: [...b.lines] });
  }
  return out;
}
