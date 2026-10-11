import type { Line, LineStatus, ProjectTree } from "@/lib/types";

export const STATUS_META: Record<LineStatus, { label: string; bar: string; chip: string }> = {
  OPEN: { label: "Draft", bar: "border-l-line", chip: "bg-panel-2 text-muted" },
  SUGGESTED: { label: "Suggested", bar: "border-l-accent", chip: "bg-accent-soft text-accent" },
  APPROVED: { label: "Approved", bar: "border-l-ok", chip: "bg-ok-soft text-ok" },
  APPROVED_EDITED: { label: "Approved (edited)", bar: "border-l-ok", chip: "bg-ok-soft text-ok" },
  DECLINED: { label: "Declined", bar: "border-l-bad", chip: "bg-bad-soft text-bad" },
  NEEDS_NEW_OPTIONS: { label: "Needs options", bar: "border-l-warn", chip: "bg-warn-soft text-warn" },
};

const LETTER_COLORS = [
  "bg-[#6d4aff] text-white",
  "bg-[#e0730b] text-white",
  "bg-[#0e9f6e] text-white",
  "bg-[#d61f69] text-white",
  "bg-[#1c64f2] text-white",
  "bg-[#9f580a] text-white",
  "bg-[#0694a2] text-white",
  "bg-[#7e3af2] text-white",
];

export function letterColor(letter: string) {
  return LETTER_COLORS[(letter.charCodeAt(0) - 65) % LETTER_COLORS.length];
}

export function isLocked(l: Pick<Line, "status">) {
  return l.status === "APPROVED" || l.status === "APPROVED_EDITED";
}

/** The current composition as plain text, grouped into couplets/stanzas. */
export function fullText(tree: ProjectTree, opts: { approvedOnly?: boolean; markdown?: boolean } = {}) {
  const parts: string[] = [];
  if (opts.markdown) parts.push(`# ${tree.project.title}`);
  for (const s of tree.sections) {
    const lines = s.lines.filter(
      (l) =>
        l.kind === "lyric" &&
        l.text.trim() &&
        l.status !== "DECLINED" &&
        (!opts.approvedOnly || isLocked(l)),
    );
    if (!lines.length) continue;
    const g = Math.max(1, s.group_size);
    const groups: string[] = [];
    for (let i = 0; i < lines.length; i += g) {
      groups.push(
        lines
          .slice(i, i + g)
          .map((l) => (opts.markdown ? `${l.text}  ` : l.text))
          .join("\n"),
      );
    }
    parts.push(`${opts.markdown ? "## " + s.name : s.name.toUpperCase()}\n\n${groups.join("\n\n")}`);
  }
  return parts.join("\n\n\n");
}

export function download(filename: string, text: string, type = "text/plain") {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const AI_ACTIONS: { label: string; instruction: string; rap?: boolean }[] = [
  { label: "Same meaning, new words", instruction: "Keep the same meaning but use different wording." },
  { label: "Better rhyme", instruction: "Make the rhyme stronger and more natural." },
  { label: "Shorter", instruction: "Make it shorter and punchier." },
  { label: "Longer", instruction: "Make it a bit longer and fuller." },
  { label: "Simpler words", instruction: "Use simpler, everyday words." },
  { label: "More modern", instruction: "Make it sound more modern and current." },
  { label: "More emotional", instruction: "Make it more emotional and vulnerable." },
  { label: "More aggressive", instruction: "Make it more aggressive and confrontational." },
  { label: "More direct", instruction: "Make it more direct — say it plainly." },
  { label: "More poetic", instruction: "Make it more poetic and image-driven." },
  { label: "Fit rhythm", instruction: "Match the syllable count and rhythm of the surrounding lines exactly." },
  { label: "Harder", instruction: "Make it harder-hitting, rap delivery.", rap: true },
  { label: "More street", instruction: "Make it more street, use slang naturally.", rap: true },
  { label: "Punchline", instruction: "Turn it into a punchline with a twist.", rap: true },
  { label: "More melodic", instruction: "Make it more melodic and singable.", rap: true },
];
