import {
  addSection,
  deleteProject,
  duplicateProject,
  redo,
  getTree,
  importSections,
  addArtist,
  removeArtist,
  updateArtist,
  saveVersion,
  setLanes,
  setSound,
  setLineTimes,
  undo,
  updateProject,
} from "@/lib/server/repo";
import { body, handle, pick, treeResponse } from "@/lib/server/http";
import { parseText } from "@/lib/text-import";
import type { Project, ProjectSettings } from "@/lib/types";
import { FX_PRESETS } from "@/lib/fx/presets";
import { access, addMember, currentUserId } from "@/lib/server/users";

export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  return handle(async () => {
    await access((await ctx.params).id, "view");
    return treeResponse((await ctx.params).id);
  });
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  return handle(async () => {
    await access((await ctx.params).id, "edit");
    const { id } = await ctx.params;
    const b = await body(req);
    await updateProject(id, pick<Project>(b, ["title", "type", "language", "concept", "settings"]));
    return treeResponse(id);
  });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  return handle(async () => {
    await access((await ctx.params).id, "own");
    await deleteProject((await ctx.params).id);
    return Response.json({ ok: true });
  });
}

/** Project actions: undo, redo, duplicate, addSection, saveVersion */
export const maxDuration = 300;

export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  return handle(async () => {
    await access((await ctx.params).id, "edit");
    const { id } = await ctx.params;
    const b = await body<{ action: string; name?: string; group_size?: number; label?: string; audio_start?: number | null; times?: { id: string; at: number | null }[]; text?: string; artistId?: string; color?: string; notes?: string; lanes?: string[]; lane?: string; preset?: string; key?: unknown }>(req);
    switch (b.action) {
      case "undo":
      case "redo": {
        // the tree, and what was undone / redone (x-undo-label)
        const label = b.action === "undo" ? await undo(id) : await redo(id);
        const res = await treeResponse(id);
        if (label) res.headers.set("x-undo-label", encodeURIComponent(label));
        return res;
      }
      case "duplicate": {
        // the copy is its maker's
        const copy = await duplicateProject(id);
        const uid = await currentUserId();
        if (uid) await addMember(copy.id, uid, "owner");
        return Response.json(copy, { status: 201 });
      }
      case "addSection":
        await addSection(id, { name: b.name ?? "New section", group_size: b.group_size, audio_start: b.audio_start ?? null });
        break;
      case "lineTimes":
        // tap-sync / reset of where lines start on the beat
        await setLineTimes(
          id,
          (b.times ?? [])
            .filter((x) => typeof x?.id === "string" && (x.at === null || Number.isFinite(x.at)))
            .slice(0, 200),
        );
        break;
      case "addArtist": {
        // returns the tree; x-artist-id = the new performer (e.g. to assign it right away)
        const a = await addArtist(id, b.name ?? "", b.color ?? "#7e3af2");
        const res = await treeResponse(id);
        res.headers.set("x-artist-id", a.id);
        return res;
      }
      case "updateArtist":
        if (!b.artistId) return Response.json({ error: "artistId required" }, { status: 400 });
        await updateArtist(id, b.artistId, { name: b.name, notes: b.notes, color: b.color });
        break;
      case "removeArtist":
        if (!b.artistId) return Response.json({ error: "artistId required" }, { status: 400 });
        await removeArtist(id, b.artistId);
        break;
      case "setSound": {
        // a layer's effect preset and / or the song's key ("chromatic" or {root 0–11, minor})
        if (b.preset !== undefined && !FX_PRESETS.some((p) => p.id === b.preset)) return Response.json({ error: "Unknown sound" }, { status: 400 });
        const k = b.key as { root?: unknown; minor?: unknown } | string | undefined;
        const key: ProjectSettings["songKey"] | undefined =
          k === "chromatic"
            ? "chromatic"
            : k && typeof k === "object" && Number.isInteger(k.root) && (k.root as number) >= 0 && (k.root as number) < 12
              ? { root: k.root as number, minor: !!k.minor }
              : undefined;
        await setSound(id, { lane: typeof b.lane === "string" ? b.lane : undefined, preset: b.preset, key });
        break;
      }
      case "setLanes":
        await setLanes(id, Array.isArray(b.lanes) ? b.lanes.filter((x) => typeof x === "string") : []);
        break;
      case "importText": {
        // pasted text added as new sections at the end of the project
        const tree = await getTree(id);
        const sections = parseText((b.text ?? "").slice(0, 50000), tree.project.type);
        if (!sections.length) return Response.json({ error: "No text to import." }, { status: 400 });
        await importSections(id, sections, tree.project.type === "song" || tree.project.type === "rap" ? 2 : 1, true);
        break;
      }
      case "saveVersion":
        await saveVersion(id, b.label ?? new Date().toLocaleString());
        break;
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
    return treeResponse(id);
  });
}
