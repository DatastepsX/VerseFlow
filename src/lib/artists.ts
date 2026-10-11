import type { Artist, Project, Section } from "./types";

/** distinct, readable on light and dark backgrounds */
export const ARTIST_COLORS = ["#d61f69", "#1c64f2", "#0e9f6e", "#e0730b", "#7e3af2", "#0694a2", "#9f580a", "#e02424"];

export function projectArtists(project: Pick<Project, "settings">): Artist[] {
  return project.settings?.artists ?? [];
}

type TreeLike = {
  project: Pick<Project, "settings">;
  /** in song order */
  sections: Pick<Section, "id" | "name" | "artists">[];
};

const cache = new WeakMap<object, Map<string, { artists: Artist[]; from: string | null }>>();

/**
 * Performers carry on: a section without its own performers is performed by
 * whoever performed the section before it, until a section gets new ones.
 */
function resolve(tree: TreeLike) {
  const hit = cache.get(tree.sections);
  if (hit) return hit;
  const all = projectArtists(tree.project);
  const map = new Map<string, { artists: Artist[]; from: string | null }>();
  let last: { artists: Artist[]; name: string } | null = null;
  for (const s of tree.sections) {
    const own = all.filter((a) => (s.artists ?? []).includes(a.id));
    if (own.length) {
      last = { artists: own, name: s.name };
      map.set(s.id, { artists: own, from: null });
    } else map.set(s.id, { artists: last?.artists ?? [], from: last?.name ?? null });
  }
  cache.set(tree.sections, map);
  return map;
}

/** who performs a section (its own performers, or carried on from the section before) */
export function sectionArtists(tree: TreeLike, section: Pick<Section, "id">): Artist[] {
  return resolve(tree).get(section.id)?.artists ?? [];
}

/** the section a section's performers carry on from (null when it has its own, or none) */
export function artistsFrom(tree: TreeLike, section: Pick<Section, "id">): string | null {
  return resolve(tree).get(section.id)?.from ?? null;
}

/** "Marco & Anna", "Marco, Anna & Luca" */
export function artistNames(artists: Pick<Artist, "name">[]) {
  const n = artists.map((a) => a.name);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} & ${n[n.length - 1]}`;
}

/** for AI prompts: who performs the section and how */
export function performedBy(tree: TreeLike, section: Pick<Section, "id">) {
  const a = sectionArtists(tree, section);
  if (!a.length) return "";
  return `\nPerformed by: ${a.map((x) => (x.notes ? `${x.name} (${x.notes})` : x.name)).join(", ")} — write in their voice${a.length > 1 ? "s" : ""}`;
}
