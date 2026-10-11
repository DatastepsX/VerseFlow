import {
  addSection,
  deleteProject,
  duplicateProject,
  redo,
  saveVersion,
  setLineTimes,
  undo,
  updateProject,
} from "@/lib/server/repo";
import { body, handle, pick, treeResponse } from "@/lib/server/http";
import type { Project } from "@/lib/types";

export async function GET(_req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  return handle(async () => treeResponse((await ctx.params).id));
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body(req);
    await updateProject(id, pick<Project>(b, ["title", "type", "language", "concept", "settings"]));
    return treeResponse(id);
  });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  return handle(async () => {
    await deleteProject((await ctx.params).id);
    return Response.json({ ok: true });
  });
}

/** Project actions: undo, redo, duplicate, addSection, saveVersion */
export const maxDuration = 300;

export async function POST(req: Request, ctx: RouteContext<"/api/projects/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{ action: string; name?: string; group_size?: number; label?: string; audio_start?: number | null; times?: { id: string; at: number | null }[] }>(req);
    switch (b.action) {
      case "undo":
        await undo(id);
        break;
      case "redo":
        await redo(id);
        break;
      case "duplicate":
        return Response.json(await duplicateProject(id), { status: 201 });
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
      case "saveVersion":
        await saveVersion(id, b.label ?? new Date().toLocaleString());
        break;
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
    return treeResponse(id);
  });
}
