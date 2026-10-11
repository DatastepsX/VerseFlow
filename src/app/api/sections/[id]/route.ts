import { addLine, deleteSection, moveSection, updateSection } from "@/lib/server/repo";
import { body, handle, pick, treeResponse } from "@/lib/server/http";
import type { LineKind, LineStatus, Section } from "@/lib/types";

export async function PATCH(req: Request, ctx: RouteContext<"/api/sections/[id]">) {
  return handle(async () => {
    const b = await body(req);
    const projectId = await updateSection(
      (await ctx.params).id,
      pick<Section>(b, ["name", "group_size", "story_beat", "intensity", "rhyme_scheme", "notes"]),
    );
    return treeResponse(projectId);
  });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/sections/[id]">) {
  return handle(async () => treeResponse(await deleteSection((await ctx.params).id)));
}

/** Section actions: addLine, move */
export async function POST(req: Request, ctx: RouteContext<"/api/sections/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{
      action: string;
      text?: string;
      status?: LineStatus;
      kind?: LineKind;
      afterLineId?: string | null;
      dir?: -1 | 1;
    }>(req);
    if (b.action === "addLine") {
      const line = await addLine(id, { text: b.text, status: b.status, kind: b.kind, afterLineId: b.afterLineId });
      const res = await treeResponse(line.project_id);
      res.headers.set("x-line-id", line.id);
      return res;
    }
    if (b.action === "move") return treeResponse(await moveSection(id, b.dir === -1 ? -1 : 1));
    return Response.json({ error: "Unknown action" }, { status: 400 });
  });
}
