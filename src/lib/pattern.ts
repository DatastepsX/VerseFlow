import type { Line, Section } from "./types";

/**
 * A section's pattern: 1–2 lines that only define rhythm, length and stresses
 * (not part of the lyrics). Set in the section's settings; lines marked as
 * rhythm reference in older projects count as pattern too.
 */
export function sectionPattern(section: Pick<Section, "pattern"> & { lines: Pick<Line, "kind" | "text">[] }): string[] {
  const own = (section.pattern ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (own.length) return own.slice(0, 4);
  return section.lines.filter((l) => l.kind === "rhythm_ref" && l.text.trim()).map((l) => l.text);
}

/** The line new bars of this section should flow like (last pattern line), if any. */
export function patternReference(section: Parameters<typeof sectionPattern>[0]): string | null {
  const p = sectionPattern(section);
  return p.length ? p[p.length - 1] : null;
}
