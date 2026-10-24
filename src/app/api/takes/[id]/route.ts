import { chooseTake, deleteTake, shiftTake } from "@/lib/server/repo";
import { body, handle, treeResponse } from "@/lib/server/http";

/** choose this take for its section + layer; {shift: s} moves it on the beat instead (± 0.5 s at most) */
export async function PATCH(req: Request, ctx: RouteContext<"/api/takes/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const b = await body<{ shift?: unknown }>(req);
    if (typeof b.shift === "number" && Number.isFinite(b.shift)) return treeResponse(await shiftTake(id, Math.max(-0.5, Math.min(0.5, b.shift))));
    return treeResponse(await chooseTake(id));
  });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/takes/[id]">) {
  return handle(async () => treeResponse(await deleteTake((await ctx.params).id)));
}
