import type { ProjectTree } from "./types";

/**
 * The song's pattern: the lines that define length, syllables and flow for
 * everything that follows. Lines marked as rhythm reference win; otherwise the
 * first section (in song order) with at least two written lines gives its
 * first two lines.
 */
export function songPattern(tree: Pick<ProjectTree, "sections">): { sectionId: string; lines: string[] } | null {
  for (const s of tree.sections) {
    const refs = s.lines.filter((l) => l.kind === "rhythm_ref" && l.text.trim()).map((l) => l.text);
    if (refs.length) return { sectionId: s.id, lines: refs.slice(0, 2) };
  }
  for (const s of tree.sections) {
    const written = s.lines.filter((l) => l.kind === "lyric" && l.text.trim() && l.status !== "DECLINED").map((l) => l.text);
    if (written.length >= 2) return { sectionId: s.id, lines: written.slice(0, 2) };
  }
  return null;
}
