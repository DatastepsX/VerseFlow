import type { Artist, Project, Section } from "./types";

/** distinct, readable on light and dark backgrounds */
export const ARTIST_COLORS = ["#d61f69", "#1c64f2", "#0e9f6e", "#e0730b", "#7e3af2", "#0694a2", "#9f580a", "#e02424"];

export function projectArtists(project: Pick<Project, "settings">): Artist[] {
  return project.settings?.artists ?? [];
}

/** the performers of a section, in the project's order */
export function sectionArtists(project: Pick<Project, "settings">, section: Pick<Section, "artists">): Artist[] {
  const ids = new Set(section.artists ?? []);
  return projectArtists(project).filter((a) => ids.has(a.id));
}

/** "Marco & Anna", "Marco, Anna & Luca" */
export function artistNames(artists: Pick<Artist, "name">[]) {
  const n = artists.map((a) => a.name);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}`;
}

/** for AI prompts: who performs the section and how */
export function performedBy(project: Pick<Project, "settings">, section: Pick<Section, "artists">) {
  const a = sectionArtists(project, section);
  if (!a.length) return "";
  return `\nPerformed by: ${a.map((x) => (x.notes ? `${x.name} (${x.notes})` : x.name)).join(", ")} — write in their voice${a.length > 1 ? "s" : ""}`;
}
