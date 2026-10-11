import { addAlternatives, deleteLine, getTree, moveLine, setBankState, splitSection, updateLine } from "@/lib/server/repo";
import { generateOptions } from "@/lib/server/ai";
import { body, handle, pick, treeResponse } from "@/lib/server/http";
import type { Line } from "@/lib/types";

export const maxDuration = 120;

export async function PATCH(req: Request, ctx: RouteContext<"/api/lines/[id]">) {
  return handle(async () => {
    const b = await body(req);
    const action = typeof b.action === "string" ? b.action : "edit";
    const projectId = await updateLine((await ctx.params).id, pick<Line>(b, ["text", "status", "kind", "note"]), action);
    if (typeof b.bankId === "string") await setBankState(b.bankId, "used");
    return treeResponse(projectId);
  });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/lines/[id]">) {
  return handle(async () => treeResponse(await deleteLine((await ctx.params).id)));
}

/** Line actions: move, addAlternative (manual), generate (AI) */
export async function POST(req: Request, ctx: RouteContext<"/api/lines/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{
      action: string;
      dir?: -1 | 1;
      text?: string;
      projectId?: string;
      scope?: "line" | "group";
      count?: number;
      instruction?: string;
      rhymeStrength?: "exact" | "loose" | "none";
      name?: string;
      start?: number | null;
    }>(req);
    switch (b.action) {
      case "splitSection":
        // this line and the ones after it become a new section (e.g. where the rap starts)
        return treeResponse(
          await splitSection(id, (b.name ?? "New section").slice(0, 60), typeof b.start === "number" && Number.isFinite(b.start) ? b.start : null),
        );
      case "move":
        return treeResponse(await moveLine(id, b.dir === -1 ? -1 : 1));
      case "addAlternative":
        return treeResponse(await addAlternatives(id, [b.text ?? ""], "user"));
      case "generate": {
        if (!b.projectId) return Response.json({ error: "projectId required" }, { status: 400 });
        const tree = await getTree(b.projectId);
        const count = Math.min(6, Math.max(1, b.count ?? 3));
        const { targetIds, options } = await generateOptions({
          tree,
          lineId: id,
          scope: b.scope ?? "line",
          count,
          instruction: b.instruction?.slice(0, 500),
          rhymeStrength: b.rhymeStrength,
        });
        // options for a couplet are stored on its first line as multi-line text
        return treeResponse(
          await addAlternatives(targetIds[0], options.map((o) => o.join("\n")), "ai", b.instruction),
        );
      }
      default:
        return Response.json({ error: "Unknown action" }, { status: 400 });
    }
  });
}
